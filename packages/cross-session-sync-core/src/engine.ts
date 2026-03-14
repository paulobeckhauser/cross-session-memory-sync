import type { SyncAdapter } from "./adapter.js";
import { Extractor } from "./extractor.js";
import { Injector } from "./injector.js";
import { KnowledgeStore } from "./store.js";
import type { SyncConfig, TurnData } from "./types.js";

export class SyncEngine implements SyncAdapter {
  private store: KnowledgeStore;
  private extractor: Extractor;
  private injector: Injector;

  constructor(config: SyncConfig) {
    this.store = new KnowledgeStore(config.dbPath);
    this.extractor = new Extractor(this.store, config);
    this.injector = new Injector(
      this.store,
      config.relevanceWindowHours,
      config.maxInjectedTokens
    );
  }

  async onTurnComplete(turn: TurnData): Promise<void> {
    try {
      await this.extractor.extract(turn);
    } catch {
      // Never throw — graceful degradation
    }
  }

  getInjectionBlock(sessionKey: string, maxTokens?: number): string {
    try {
      return this.injector.getContextBlock(sessionKey, maxTokens);
    } catch {
      return "";
    }
  }

  cleanup(): void {
    try {
      this.store.cleanup(48); // prune nuggets older than 48h
    } catch {
      // Silent failure
    }
  }

  close(): void {
    this.store.close();
  }
}
