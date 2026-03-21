import { DAGStore } from "./dag-store.js";
import { Extractor } from "./extractor.js";
import { Compressor, COMPRESSION_PROMPTS } from "./compressor.js";
import { Assembler } from "./assembler.js";
import type { SyncAdapter } from "./adapter.js";
import type { DAGSyncConfig, TurnData } from "./types.js";

export { COMPRESSION_PROMPTS };

export class SyncEngine implements SyncAdapter {
  private store: DAGStore;
  private extractor: Extractor;
  private compressor: Compressor;
  private assembler: Assembler;
  private config: DAGSyncConfig;

  constructor(config: DAGSyncConfig) {
    this.config = config;
    this.store = new DAGStore(config.dbPath);
    this.extractor = new Extractor(
      this.store,
      config.classifierFn,
      config.noiseFilterPatterns,
      config.confidenceThreshold
    );
    this.compressor = new Compressor(
      this.store,
      config.compressorFn,
      config.compressionThresholds,
      config.maxDepth
    );
    this.assembler = new Assembler(this.store);
  }

  async onTurnComplete(turn: TurnData): Promise<void> {
    try {
      await this.extractor.extract(turn);

      // Check if compression is needed (async, non-blocking)
      const pending = this.compressor.needsCompression();
      if (pending.length > 0) {
        // Fire and forget — never block user turns
        this.compressor.runCompressionPass().catch(() => {
          // Graceful degradation: compression failure is non-fatal
        });
      }
    } catch {
      // Graceful degradation: extraction failure is non-fatal
    }
  }

  getInjectionBlock(sessionKey: string, maxTokens?: number): string {
    try {
      return this.assembler.assembleContext(
        sessionKey,
        maxTokens ?? this.config.maxInjectedTokens
      );
    } catch {
      return "";
    }
  }

  async runCompression(): Promise<void> {
    await this.compressor.runCompressionPass();
  }

  cleanup(): void {
    try {
      this.store.cleanup(this.config.relevanceWindowHours * 2);
    } catch {
      // Non-fatal
    }
  }

  close(): void {
    this.store.close();
  }
}
