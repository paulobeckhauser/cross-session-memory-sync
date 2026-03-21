import type { TurnData } from "./types.js";

export interface SyncAdapter {
  /** Called by adapter after each LLM turn */
  onTurnComplete(turn: TurnData): Promise<void>;

  /** Called by adapter before prompt assembly — returns context block string */
  getInjectionBlock(sessionKey: string, maxTokens?: number): string;

  /** Prune expired nuggets */
  cleanup(): void;
}
