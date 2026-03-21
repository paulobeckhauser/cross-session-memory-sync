import { DAGStore } from "./dag-store.js";
import type { DAGNode } from "./types.js";

export class Assembler {
  private store: DAGStore;

  constructor(store: DAGStore) {
    this.store = store;
  }

  assembleContext(
    currentSessionKey: string,
    maxTokens: number = 500
  ): string {
    const allActive = this.store.getActiveNodes(currentSessionKey);

    if (allActive.length === 0) return "";

    const recentFacts = allActive.filter((n) => n.depth === 0);
    const summaries = allActive.filter((n) => n.depth > 0);

    const lines: string[] = [];
    let estimatedTokens = 0;

    // Header
    lines.push("## Cross-Session Context");
    estimatedTokens += 5;

    // Recent facts (priority 1)
    if (recentFacts.length > 0) {
      lines.push("### Recent");
      estimatedTokens += 3;

      for (const fact of recentFacts) {
        const line = formatFact(fact);
        const lineTokens = estimateTokens(line);

        if (estimatedTokens + lineTokens > maxTokens) break;

        lines.push(line);
        estimatedTokens += lineTokens;
      }
    }

    // Background summaries (priority 2)
    if (summaries.length > 0 && estimatedTokens < maxTokens) {
      lines.push("### Background");
      estimatedTokens += 3;

      for (const summary of summaries) {
        const line = `- ${summary.content}`;
        const lineTokens = estimateTokens(line);

        if (estimatedTokens + lineTokens > maxTokens) break;

        lines.push(line);
        estimatedTokens += lineTokens;
      }
    }

    // Only header — nothing useful
    if (lines.length <= 1) return "";

    return lines.join("\n");
  }
}

function formatFact(node: DAGNode): string {
  const parts: string[] = [];

  if (node.sourceChannel) {
    const age = formatAge(node.createdAt);
    parts.push(`[${node.sourceChannel}, ${age}]`);
  }

  parts.push(node.content);
  return `- ${parts.join(" ")}`;
}

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}min ago`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}
