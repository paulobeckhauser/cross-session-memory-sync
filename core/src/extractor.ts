import { randomUUID } from "crypto";
import { NoiseFilter } from "./noise-filter.js";
import { Classifier } from "./classifier.js";
import { DAGStore } from "./dag-store.js";
import type { ClassifierFn, TurnData } from "./types.js";

export class Extractor {
  private noiseFilter: NoiseFilter;
  private classifier: Classifier;
  private store: DAGStore;
  private confidenceThreshold: number;

  constructor(
    store: DAGStore,
    classifierFn: ClassifierFn,
    noiseFilterPatterns: string[],
    confidenceThreshold: number
  ) {
    this.store = store;
    this.noiseFilter = new NoiseFilter(noiseFilterPatterns);
    this.classifier = new Classifier(classifierFn);
    this.confidenceThreshold = confidenceThreshold;
  }

  async extract(turn: TurnData): Promise<number> {
    // Step 1: heuristic pre-filter
    if (!this.noiseFilter.shouldProcess(turn.userMessage)) {
      return 0;
    }

    // Step 2: LLM classification
    const nuggets = await this.classifier.classify(
      turn.userMessage,
      turn.assistantMessage
    );

    if (!nuggets || nuggets.length === 0) return 0;

    let inserted = 0;

    for (const nugget of nuggets) {
      if (nugget.confidence < this.confidenceThreshold) continue;

      // Step 3: conflict detection — check for existing facts in same category
      const existing = this.store.getActiveFactsByCategory(nugget.category);
      for (const old of existing) {
        // Overlap check: if content is similar enough, supersede
        // sameCategory=true since we already filtered by category
        if (contentOverlaps(old.content, nugget.fact, true)) {
          this.store.supersede(old.id, "pending");
        }
      }

      // Step 4: insert as d0 leaf node
      const id = randomUUID();
      this.store.insertFact({
        id,
        content: nugget.fact,
        category: nugget.category,
        confidence: nugget.confidence,
        sourceSession: turn.sessionKey,
        sourceChannel: turn.channel,
        createdAt: new Date().toISOString(),
      });

      // Update supersede references with actual ID
      for (const old of existing) {
        if (contentOverlaps(old.content, nugget.fact, true)) {
          this.store.supersede(old.id, id);
        }
      }

      inserted++;
    }

    return inserted;
  }
}

function contentOverlaps(existing: string, incoming: string, sameCategory = false): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "can", "shall",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "and",
    "but", "or", "nor", "not", "so", "yet", "both", "either",
    "neither", "each", "every", "all", "any", "few", "more",
    "most", "other", "some", "such", "no", "only", "own", "same",
    "than", "too", "very", "just", "about", "above", "below",
    "i", "me", "my", "we", "our", "you", "your", "he", "she",
    "it", "its", "they", "them", "their", "this", "that", "these",
  ]);

  const existingWords = normalize(existing).split(/\s+/).filter((w) => !stopWords.has(w));
  const incomingWords = normalize(incoming).split(/\s+/).filter((w) => !stopWords.has(w));

  if (existingWords.length === 0 || incomingWords.length === 0) return false;

  const existingSet = new Set(existingWords);
  let overlap = 0;
  for (const word of incomingWords) {
    if (existingSet.has(word)) overlap++;
  }

  const overlapRatio = overlap / incomingWords.length;

  // When facts share the same category, use a lower threshold since
  // they are more likely to be about the same topic even with different phrasing.
  if (sameCategory) {
    // Direct word overlap with lower threshold for same-category facts
    if (overlapRatio > 0.3) return true;

    // Entity-level matching: extract key nouns/entities (words >= 4 chars,
    // which filters out short common words the stop list may have missed)
    // and check if they share enough entities to indicate the same subject.
    const entityMinLen = 4;
    const existingEntities = new Set(existingWords.filter((w) => w.length >= entityMinLen));
    const incomingEntities = incomingWords.filter((w) => w.length >= entityMinLen);

    if (existingEntities.size > 0 && incomingEntities.length > 0) {
      let entityOverlap = 0;
      for (const entity of incomingEntities) {
        if (existingEntities.has(entity)) entityOverlap++;
      }
      // If at least 2 shared entities (or all entities if fewer), treat as conflict
      if (entityOverlap >= 2 || (entityOverlap >= 1 && incomingEntities.length <= 2)) {
        return true;
      }
    }

    return false;
  }

  // Cross-category: require >60% of content words to match for a conflict
  return overlapRatio > 0.6;
}
