import { v4 as uuidv4 } from "uuid";
import { Classifier } from "./classifier.js";
import { NoiseFilter } from "./noise-filter.js";
import { KnowledgeStore } from "./store.js";
import type { KnowledgeNugget, TurnData, SyncConfig } from "./types.js";

export class Extractor {
  private store: KnowledgeStore;
  private classifier: Classifier;
  private noiseFilter: NoiseFilter;
  private confidenceThreshold: number;

  constructor(store: KnowledgeStore, config: SyncConfig) {
    this.store = store;
    this.classifier = new Classifier(config.classifierFn);
    this.noiseFilter = new NoiseFilter(config.noiseFilterPatterns);
    this.confidenceThreshold = config.confidenceThreshold;
  }

  async extract(turn: TurnData): Promise<KnowledgeNugget[]> {
    if (!this.noiseFilter.shouldProcess(turn.userMessage)) {
      return [];
    }

    const classified = await this.classifier.classify(
      turn.userMessage,
      turn.assistantMessage
    );

    if (!classified || classified.length === 0) {
      return [];
    }

    const nuggets: KnowledgeNugget[] = [];

    for (const item of classified) {
      if (item.confidence < this.confidenceThreshold) {
        continue;
      }

      const nugget: KnowledgeNugget = {
        id: uuidv4(),
        fact: item.fact,
        category: item.category,
        confidence: item.confidence,
        sourceSession: turn.sessionKey,
        sourceChannel: turn.channel,
        createdAt: new Date().toISOString(),
      };

      // Check for conflicting nuggets and supersede
      const existing = this.store.findConflicting(
        item.category,
        turn.sessionKey
      );
      if (existing) {
        this.store.supersede(existing.id, nugget.id);
      }

      this.store.insertNugget(nugget);
      nuggets.push(nugget);
    }

    return nuggets;
  }
}
