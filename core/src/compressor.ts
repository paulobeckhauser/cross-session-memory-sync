import { randomUUID } from "crypto";
import { DAGStore } from "./dag-store.js";
import type { CompressorFn, DAGNode } from "./types.js";

export const COMPRESSION_PROMPTS: Record<string, string> = {
  d0_to_d1:
    "Summarize these recent facts into a concise paragraph. Preserve dates, names, and specifics:\n",
  d1_to_d2:
    "Consolidate these summaries into key themes. Be concise but preserve critical details:\n",
};

export class Compressor {
  private store: DAGStore;
  private compressorFn: CompressorFn;
  private thresholds: Record<number, number>;
  private maxDepth: number;

  constructor(
    store: DAGStore,
    compressorFn: CompressorFn,
    thresholds: Record<number, number>,
    maxDepth: number
  ) {
    this.store = store;
    this.compressorFn = compressorFn;
    this.thresholds = thresholds;
    this.maxDepth = maxDepth;
  }

  needsCompression(): { depth: number; category: string; count: number }[] {
    const results: { depth: number; category: string; count: number }[] = [];

    for (let depth = 0; depth < this.maxDepth; depth++) {
      const threshold = this.thresholds[depth] ?? this.thresholds[2] ?? 5;
      const categories = this.store.getCategories(depth);

      for (const category of categories) {
        const nodes = this.store.getUncompressedNodes(depth, category);
        if (nodes.length >= threshold) {
          results.push({ depth, category, count: nodes.length });
        }
      }
    }

    return results;
  }

  async compress(depth: number, category: string): Promise<DAGNode | null> {
    const nodes = this.store.getUncompressedNodes(depth, category);
    if (nodes.length < 2) return null;

    const facts = nodes.map((n) => n.content);
    let summary: string;

    try {
      // Level 1: normal compression
      summary = await this.compressorFn(facts, depth);
    } catch {
      try {
        // Level 2: aggressive — half the facts (most recent)
        const halfFacts = facts.slice(Math.floor(facts.length / 2));
        summary = await this.compressorFn(halfFacts, depth);
      } catch {
        // Level 3: deterministic truncation — keep most recent, drop oldest
        const kept = facts.slice(Math.floor(facts.length / 2));
        summary = kept.join("; ");
      }
    }

    const summaryNode: DAGNode = {
      id: randomUUID(),
      depth: depth + 1,
      content: summary,
      category: nodes[0].category,
      confidence: 1.0,
      createdAt: new Date().toISOString(),
      isCompressed: false,
    };

    this.store.insertSummary({
      id: summaryNode.id,
      depth: summaryNode.depth,
      content: summaryNode.content,
      category: summaryNode.category,
      createdAt: summaryNode.createdAt,
      childIds: nodes.map((n) => n.id),
    });

    return summaryNode;
  }

  async runCompressionPass(): Promise<void> {
    const pending = this.needsCompression();
    for (const { depth, category } of pending) {
      await this.compress(depth, category);
    }
  }
}
