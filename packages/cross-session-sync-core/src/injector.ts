import { KnowledgeStore } from "./store.js";
import type { KnowledgeNugget } from "./types.js";

export class Injector {
  private store: KnowledgeStore;
  private relevanceWindowHours: number;
  private maxInjectedTokens: number;

  constructor(
    store: KnowledgeStore,
    relevanceWindowHours: number,
    maxInjectedTokens: number
  ) {
    this.store = store;
    this.relevanceWindowHours = relevanceWindowHours;
    this.maxInjectedTokens = maxInjectedTokens;
  }

  getContextBlock(sessionKey: string, maxTokens?: number): string {
    const budget = maxTokens ?? this.maxInjectedTokens;
    const nuggets = this.store.getActiveNuggets(
      sessionKey,
      this.relevanceWindowHours
    );

    if (nuggets.length === 0) return "";

    const lines: string[] = [];
    let estimatedTokens = 10; // header overhead

    for (const nugget of nuggets) {
      const line = this.formatNuggetLine(nugget);
      const lineTokens = this.estimateTokens(line);

      if (estimatedTokens + lineTokens > budget) break;

      lines.push(line);
      estimatedTokens += lineTokens;
    }

    if (lines.length === 0) return "";

    return `## Cross-Session Context\n${lines.join("\n")}`;
  }

  private formatNuggetLine(nugget: KnowledgeNugget): string {
    const age = this.formatAge(nugget.createdAt);
    return `- [${nugget.sourceChannel}, ${age}] ${nugget.fact}`;
  }

  private formatAge(isoDate: string): string {
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}min ago`;

    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}hr ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  private estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}
