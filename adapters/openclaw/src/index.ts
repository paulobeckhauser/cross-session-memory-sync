import * as os from "os";
import * as path from "path";
import {
  SyncEngine,
  CLASSIFIER_PROMPT,
  COMPRESSION_PROMPTS,
  DEFAULT_DAG_CONFIG,
} from "cross-session-sync-core";
import type { DAGSyncConfig, ClassifiedNugget } from "cross-session-sync-core";

// Minimal type stubs for OpenClaw plugin API — the actual types live in OpenClaw core
interface PluginAPI {
  agentId: string;
  config: Record<string, unknown>;
  llm: {
    chat(options: { model: string; messages: Array<{ role: string; content: string }> }): Promise<string>;
  };
  hooks: {
    on(event: string, handler: (...args: unknown[]) => unknown): void;
  };
  services: {
    register(name: string, service: { interval: number; fn: () => void }): void;
  };
}

interface BeforePromptBuildEvent {
  sessionKey: string;
}

interface MessagePreprocessedEvent {
  userMessage: string;
  assistantMessage: string;
  sessionKey: string;
  channel: string;
}

let engine: SyncEngine | null = null;

export function register(api: PluginAPI): void {
  const pluginConfig = api.config;

  const classifierModel = (pluginConfig.classifierModel as string) ?? "claude-haiku-4-5-20251001";
  const extractionEnabled = (pluginConfig.extractionEnabled as boolean) ?? true;
  const injectionEnabled = (pluginConfig.injectionEnabled as boolean) ?? true;
  const relevanceWindowHours = (pluginConfig.relevanceWindowHours as number) ?? DEFAULT_DAG_CONFIG.relevanceWindowHours;
  const maxInjectedTokens = (pluginConfig.maxInjectedTokens as number) ?? DEFAULT_DAG_CONFIG.maxInjectedTokens;
  const compressionThreshold = (pluginConfig.compressionThreshold as number) ?? 20;

  const dbDir = path.join(os.homedir(), ".openclaw", "memory");
  const dbPath = path.join(dbDir, `${api.agentId}-knowledge-dag.sqlite`);

  const classifierFn = async (userMessage: string, assistantMessage: string): Promise<ClassifiedNugget[] | null> => {
    const prompt = CLASSIFIER_PROMPT
      .replace("{userMessage}", userMessage)
      .replace("{assistantMessage}", assistantMessage);

    const response = await api.llm.chat({
      model: classifierModel,
      messages: [{ role: "user", content: prompt }],
    });

    const parsed = JSON.parse(response);
    return parsed;
  };

  const compressorFn = async (facts: string[], depth: number): Promise<string> => {
    const promptKey = depth === 0 ? "d0_to_d1" : "d1_to_d2";
    const prompt = COMPRESSION_PROMPTS[promptKey] + facts.map((f) => `- ${f}`).join("\n");

    return api.llm.chat({
      model: classifierModel,
      messages: [{ role: "user", content: prompt }],
    });
  };

  const config: DAGSyncConfig = {
    dbPath,
    classifierFn,
    compressorFn,
    relevanceWindowHours,
    maxInjectedTokens,
    confidenceThreshold: DEFAULT_DAG_CONFIG.confidenceThreshold,
    noiseFilterPatterns: DEFAULT_DAG_CONFIG.noiseFilterPatterns,
    compressionThresholds: { 0: compressionThreshold, 1: 10, 2: 5 },
    maxDepth: DEFAULT_DAG_CONFIG.maxDepth,
  };

  engine = new SyncEngine(config);

  // Hook: inject cross-session context before prompt assembly
  if (injectionEnabled) {
    api.hooks.on("before_prompt_build", (event: unknown) => {
      const { sessionKey } = event as BeforePromptBuildEvent;
      const block = engine!.getInjectionBlock(sessionKey, maxInjectedTokens);
      if (block) {
        return { prependSystemContext: block };
      }
      return undefined;
    });
  }

  // Hook: extract facts after each turn
  if (extractionEnabled) {
    api.hooks.on("message:preprocessed", (event: unknown) => {
      const { userMessage, assistantMessage, sessionKey, channel } =
        event as MessagePreprocessedEvent;
      engine!.onTurnComplete({ userMessage, assistantMessage, sessionKey, channel }).catch(() => {
        // Silent failure — never break the session
      });
    });
  }

  // Service: periodic cleanup of old facts
  api.services.register("cross-session-sync-cleanup", {
    interval: 6 * 60 * 60 * 1000, // every 6 hours
    fn: () => engine!.cleanup(),
  });
}

export function deactivate(): void {
  if (engine) {
    engine.close();
    engine = null;
  }
}
