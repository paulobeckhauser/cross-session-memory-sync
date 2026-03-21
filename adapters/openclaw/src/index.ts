import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
  SyncEngine,
  CLASSIFIER_PROMPT,
  COMPRESSION_PROMPTS,
  DEFAULT_DAG_CONFIG,
} from "cross-session-sync-core";
import type { DAGSyncConfig, ClassifiedNugget } from "cross-session-sync-core";

// ── OpenClaw plugin API type stubs ──────────────────────────────────
// These match the real OpenClaw plugin API surface (src/plugins/types.ts)

interface PluginLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface InternalHookEvent {
  type: string;
  action: string;
  context?: Record<string, unknown>;
}

interface PluginConfigSchema {
  type: "object";
  properties: Record<string, unknown>;
}

interface OpenClawPluginService {
  id: string;
  start: (ctx: { config: unknown; stateDir: string; logger: PluginLogger }) => void | Promise<void>;
  stop?: (ctx: { config: unknown; stateDir: string; logger: PluginLogger }) => void | Promise<void>;
}

interface OpenClawPluginApi {
  id: string;
  name: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registrationMode: string;
  runtime: {
    agent: {
      runEmbeddedPiAgent: (params: {
        sessionId: string;
        sessionKey: string;
        prompt: string;
        config: unknown;
        workspaceDir: string;
        [key: string]: unknown;
      }) => Promise<{ payloads: Array<{ text: string }> }>;
      resolveAgentDir: (params: { config: unknown }) => string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  logger: PluginLogger;
  registerHook: (
    events: string | string[],
    handler: (event: InternalHookEvent) => unknown,
    opts?: { priority?: number },
  ) => void;
  registerService: (service: OpenClawPluginService) => void;
  [key: string]: unknown;
}

// ── Plugin state ────────────────────────────────────────────────────

let engine: SyncEngine | null = null;
let engineConfig: DAGSyncConfig | null = null;

// Deduplication guard: track last processed message to avoid duplicate
// extraction when OpenClaw fires message:preprocessed multiple times
// during registry passes.
let lastProcessedMessageKey: string | null = null;

function getEngine(): SyncEngine {
  if (!engine && engineConfig) {
    const dbDir = path.dirname(engineConfig.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    engine = new SyncEngine(engineConfig);
  }
  return engine!;
}

// ── Plugin entry ────────────────────────────────────────────────────

// OpenClaw external plugins export { id, name, description, configSchema?, register }
export const id = "cross-session-sync";
export const name = "Cross-Session Knowledge Sync";
export const description =
  "Synchronizes knowledge across sessions via a shared Knowledge DAG with LCM-inspired hierarchical compression";

export const configSchema: PluginConfigSchema = {
  type: "object",
  properties: {
    classifierModel: {
      type: "string",
      default: "gpt-4o-mini",
      description: "OpenAI model used for fact extraction and classification",
    },
    extractionEnabled: {
      type: "boolean",
      default: true,
      description: "Whether to extract facts from turns",
    },
    injectionEnabled: {
      type: "boolean",
      default: true,
      description: "Whether to inject cross-session context",
    },
    relevanceWindowHours: {
      type: "number",
      default: 24,
      description: "How far back to look for facts (hours)",
    },
    maxInjectedTokens: {
      type: "number",
      default: 500,
      description: "Maximum tokens to inject as cross-session context",
    },
    compressionThreshold: {
      type: "number",
      default: 20,
      description: "Number of d0 facts before triggering compression",
    },
  },
};

export function register(api: OpenClawPluginApi): void {
  const pluginConfig = api.pluginConfig || {};
  const log = api.logger;

  const classifierModel = (pluginConfig.classifierModel as string) ?? "gpt-4o-mini";
  const extractionEnabled = (pluginConfig.extractionEnabled as boolean) ?? true;
  const injectionEnabled = (pluginConfig.injectionEnabled as boolean) ?? true;
  const relevanceWindowHours = (pluginConfig.relevanceWindowHours as number) ?? DEFAULT_DAG_CONFIG.relevanceWindowHours;
  const maxInjectedTokens = (pluginConfig.maxInjectedTokens as number) ?? DEFAULT_DAG_CONFIG.maxInjectedTokens;
  const compressionThreshold = (pluginConfig.compressionThreshold as number) ?? 20;

  const agentId = api.id || "default";
  const dbDir = path.join(os.homedir(), ".openclaw", "memory");
  const dbPath = path.join(dbDir, `${agentId}-knowledge-dag.sqlite`);

  // Resolve OpenAI API key: env var first, then OpenClaw auth profiles
  let openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    try {
      const authProfilesPath = path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
      if (fs.existsSync(authProfilesPath)) {
        const authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, "utf-8"));
        const profiles = authProfiles.profiles || {};
        // Try lastGood first, then any openai profile
        const lastGoodId = authProfiles.lastGood?.openai;
        const profile = (lastGoodId && profiles[lastGoodId]) || profiles["openai:default"] || profiles["openai:manual"];
        if (profile) {
          openaiApiKey = profile.key || profile.token;
        }
      }
    } catch {
      // ignore auth profile read errors
    }
  }
  if (!openaiApiKey) {
    log.warn("[cross-session-sync] No OpenAI API key found — classifier/compressor will be disabled");
  } else {
    log.info("[cross-session-sync] OpenAI API key resolved");
  }

  // Helper: call OpenAI chat completions API
  async function openaiChat(prompt: string): Promise<string> {
    if (!openaiApiKey) throw new Error("OPENAI_API_KEY not set");

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: classifierModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 512,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return json.choices[0].message.content;
  }

  // Classifier: extract facts from conversation turns via OpenAI
  const classifierFn = async (userMessage: string, assistantMessage: string): Promise<ClassifiedNugget[] | null> => {
    if (!openaiApiKey) return null;

    const prompt = CLASSIFIER_PROMPT
      .replace("{userMessage}", userMessage)
      .replace("{assistantMessage}", assistantMessage);

    const response = await openaiChat(prompt);
    const trimmed = response.trim();

    if (trimmed === "null" || trimmed === "") return null;

    const parsed = JSON.parse(trimmed);
    return parsed;
  };

  // Compressor: summarize facts via OpenAI
  const compressorFn = async (facts: string[], depth: number): Promise<string> => {
    if (!openaiApiKey) return facts.join("; ");

    const promptKey = depth === 0 ? "d0_to_d1" : "d1_to_d2";
    const prompt = COMPRESSION_PROMPTS[promptKey] + facts.map((f) => `- ${f}`).join("\n");

    return openaiChat(prompt);
  };

  // Store config for lazy initialization
  engineConfig = {
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

  const hooksEnabled = (api.config as any)?.hooks?.internal?.enabled;
  log.info(`[cross-session-sync] configured (extraction=${extractionEnabled}, injection=${injectionEnabled}, hooks.internal.enabled=${hooksEnabled}, mode=${api.registrationMode})`);

  // Skip hook registration if internal hooks are not enabled — prevents
  // the first config-less discovery pass from claiming the hook name slot
  // and blocking the real gateway pass from registering the actual handler.
  if (!hooksEnabled) {
    log.info("[cross-session-sync] skipping hook registration (hooks.internal.enabled is not true)");
    return;
  }

  // Hook: inject cross-session context before every LLM call via before_prompt_build.
  // This fires on every turn (not just session start), so updates from other channels
  // are immediately visible even within an existing session.
  if (injectionEnabled && (api as any).on) {
    (api as any).on("before_prompt_build", (
      _event: { prompt: string; messages: unknown[] },
      ctx: { sessionKey?: string; channelId?: string },
    ) => {
      const sessionKey = ctx?.sessionKey || "";
      if (!sessionKey) return;

      try {
        const block = getEngine().getInjectionBlock(sessionKey, maxInjectedTokens);
        if (block) {
          log.info(`[cross-session-sync] injecting ${block.length} chars via before_prompt_build for session: ${sessionKey}`);
          return { prependContext: `# Cross-Session Context\n\n${block}\n\n` };
        }
      } catch (err) {
        log.error(`[cross-session-sync] injection error: ${err}`);
      }
      return undefined;
    });
  }

  // Hook: extract facts after each LLM turn using llm_input (user message) + llm_output (assistant response).
  // This ensures the classifier sees both sides of the conversation for better extraction quality.
  if (extractionEnabled && (api as any).on) {
    // Capture user prompt per session from llm_input
    const pendingUserPrompts = new Map<string, string>();

    (api as any).on("llm_input", (
      event: { prompt: string; sessionId: string },
      ctx: { sessionKey?: string; channelId?: string },
    ) => {
      const sessionKey = ctx?.sessionKey || "";
      if (sessionKey && event.prompt) {
        pendingUserPrompts.set(sessionKey, event.prompt);
      }
    });

    // Extract facts on llm_output when we have both user + assistant messages
    (api as any).on("llm_output", (
      event: { assistantTexts: string[]; sessionId: string },
      ctx: { sessionKey?: string; channelId?: string },
    ) => {
      const sessionKey = ctx?.sessionKey || "";
      const channelId = ctx?.channelId || "";
      const userMessage = pendingUserPrompts.get(sessionKey) || "";
      const assistantMessage = (event.assistantTexts || []).join("\n");

      // Clean up pending prompt
      pendingUserPrompts.delete(sessionKey);

      if (!userMessage) return;

      // Deduplication: skip if we already processed this exact message
      const messageKey = `${sessionKey}:${userMessage}`;
      if (messageKey === lastProcessedMessageKey) return;
      lastProcessedMessageKey = messageKey;

      log.info(`[cross-session-sync] llm_output session=${sessionKey} channel=${channelId} user="${userMessage.slice(0, 60)}" assistant="${assistantMessage.slice(0, 60)}"`);

      getEngine().onTurnComplete({
        userMessage,
        assistantMessage,
        sessionKey,
        channel: channelId,
      }).catch((err: unknown) => {
        log.error(`[cross-session-sync] extraction error: ${err}`);
      });
    });
  }

  // Service: periodic cleanup of old facts
  api.registerService({
    id: "cross-session-sync-cleanup",
    start: () => {
      // Perform initial cleanup on start
      try {
        getEngine().cleanup();
        log.info("[cross-session-sync] initial cleanup complete");
      } catch (err) {
        log.error(`[cross-session-sync] cleanup error: ${err}`);
      }
    },
    stop: () => {
      if (engine) {
        engine.close();
        engine = null;
      }
    },
  });
}

export function deactivate(): void {
  if (engine) {
    engine.close();
    engine = null;
  }
  engineConfig = null;
}
