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

// ── LLM Provider abstraction ─────────────────────────────────────────

interface LLMProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

// All supported providers use the OpenAI-compatible chat completions format.
// This covers: OpenAI, Anthropic (via proxy), Google Gemini (via proxy),
// DeepSeek, Mistral, Groq, and local Ollama — they all expose the same
// POST /v1/chat/completions endpoint.
//
// Cost guidance: the classifier is a structured JSON extraction task — small,
// cheap models (< $1/1M input tokens) are ideal. Models above that threshold
// add cost without meaningful quality improvement.
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string; envKey: string; costPer1MInput: number }> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    envKey: "OPENAI_API_KEY",
    costPer1MInput: 0.15,
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5-20251001",
    envKey: "ANTHROPIC_API_KEY",
    costPer1MInput: 0.80,
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash-lite",
    envKey: "GEMINI_API_KEY",
    costPer1MInput: 0.075,
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
    costPer1MInput: 0.14,
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    envKey: "MISTRAL_API_KEY",
    costPer1MInput: 0.10,
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.1-8b-instant",
    envKey: "GROQ_API_KEY",
    costPer1MInput: 0.00,  // free tier
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "phi3:mini",
    envKey: "",  // no key needed
    costPer1MInput: 0.00,  // local
  },
};

function resolveProvider(
  pluginConfig: Record<string, unknown>,
  log: PluginLogger,
): LLMProviderConfig | null {
  const providerName = ((pluginConfig.classifierProvider as string) ?? "openai").toLowerCase();
  const defaults = PROVIDER_DEFAULTS[providerName];

  if (!defaults) {
    log.warn(`[cross-session-sync] Unknown provider "${providerName}", falling back to openai`);
    return resolveProvider({ ...pluginConfig, classifierProvider: "openai" }, log);
  }

  const baseUrl = (pluginConfig.classifierBaseUrl as string) ?? defaults.baseUrl;
  const model = (pluginConfig.classifierModel as string) ?? defaults.model;

  // Resolve API key: explicit config > env var > OpenClaw auth profiles
  let apiKey = pluginConfig.classifierApiKey as string | undefined;

  if (!apiKey && defaults.envKey) {
    apiKey = process.env[defaults.envKey];
  }

  // Try OpenClaw auth profiles for known providers
  if (!apiKey && providerName === "openai") {
    apiKey = resolveOpenClawAuthKey("openai");
  }

  // Ollama doesn't need a key
  if (!apiKey && providerName === "ollama") {
    apiKey = "ollama";  // placeholder, Ollama ignores auth
  }

  if (!apiKey) {
    log.warn(`[cross-session-sync] No API key for provider "${providerName}" — classifier/compressor disabled`);
    return null;
  }

  // Warn if using a model that costs more than $1/1M input tokens — the
  // classifier is a structured JSON extraction task where cheap models
  // (gpt-4o-mini, gemini-flash-lite) perform just as well as expensive ones.
  const MAX_RECOMMENDED_COST = 1.0;  // $/1M input tokens
  if (defaults.costPer1MInput > MAX_RECOMMENDED_COST) {
    log.warn(
      `[cross-session-sync] Provider "${providerName}" (${model}) costs $${defaults.costPer1MInput}/1M input tokens — ` +
      `this exceeds the recommended $${MAX_RECOMMENDED_COST}/1M ceiling for classification. ` +
      `Cheaper models (gpt-4o-mini, gemini-flash-lite, ollama) perform equally well for this task.`
    );
  }

  log.info(`[cross-session-sync] Using provider: ${providerName} (model: ${model}, baseUrl: ${baseUrl}, ~$${defaults.costPer1MInput}/1M input tokens)`);
  return { provider: providerName, apiKey, baseUrl, model };
}

function resolveOpenClawAuthKey(provider: string): string | undefined {
  try {
    const authProfilesPath = path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
    if (fs.existsSync(authProfilesPath)) {
      const authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, "utf-8"));
      const profiles = authProfiles.profiles || {};
      const lastGoodId = authProfiles.lastGood?.[provider];
      const profile = (lastGoodId && profiles[lastGoodId])
        || profiles[`${provider}:default`]
        || profiles[`${provider}:manual`];
      if (profile) {
        return profile.key || profile.token;
      }
    }
  } catch {
    // ignore auth profile read errors
  }
  return undefined;
}

// OpenAI-compatible chat completions call — works with all providers
async function chatCompletion(config: LLMProviderConfig, prompt: string): Promise<string> {
  const url = `${config.baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Anthropic uses a different auth header
  if (config.provider === "anthropic") {
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${config.provider} API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return json.choices[0].message.content;
}

// ── Plugin state ────────────────────────────────────────────────────

let engine: SyncEngine | null = null;
let engineConfig: DAGSyncConfig | null = null;

// Deduplication guard: track last processed message to avoid duplicate
// extraction when OpenClaw fires message:preprocessed multiple times
// during registry passes.
let lastProcessedMessageKey: string | null = null;
let hooksRegistered = false;

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
    classifierProvider: {
      type: "string",
      default: "openai",
      description: "LLM provider: openai, anthropic, gemini, deepseek, mistral, groq, ollama",
    },
    classifierModel: {
      type: "string",
      default: "",
      description: "Model name (defaults to provider's recommended cheap model)",
    },
    classifierBaseUrl: {
      type: "string",
      default: "",
      description: "Custom API base URL (for self-hosted or proxy setups)",
    },
    classifierApiKey: {
      type: "string",
      default: "",
      description: "Explicit API key (overrides env var and auth profiles)",
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

  const extractionEnabled = (pluginConfig.extractionEnabled as boolean) ?? true;
  const injectionEnabled = (pluginConfig.injectionEnabled as boolean) ?? true;
  const relevanceWindowHours = (pluginConfig.relevanceWindowHours as number) ?? DEFAULT_DAG_CONFIG.relevanceWindowHours;
  const maxInjectedTokens = (pluginConfig.maxInjectedTokens as number) ?? DEFAULT_DAG_CONFIG.maxInjectedTokens;
  const compressionThreshold = (pluginConfig.compressionThreshold as number) ?? 20;

  const agentId = api.id || "default";
  const dbDir = path.join(os.homedir(), ".openclaw", "memory");
  const dbPath = path.join(dbDir, `${agentId}-knowledge-dag.sqlite`);

  // Resolve LLM provider
  const llmConfig = resolveProvider(pluginConfig, log);

  // Classifier: extract facts from conversation turns
  const classifierFn = async (userMessage: string, assistantMessage: string): Promise<ClassifiedNugget[] | null> => {
    if (!llmConfig) return null;

    const prompt = CLASSIFIER_PROMPT
      .replace("{userMessage}", userMessage)
      .replace("{assistantMessage}", assistantMessage);

    const response = await chatCompletion(llmConfig, prompt);
    const trimmed = response.trim();

    if (trimmed === "null" || trimmed === "") return null;

    const parsed = JSON.parse(trimmed);
    return parsed;
  };

  // Compressor: summarize facts
  const compressorFn = async (facts: string[], depth: number): Promise<string> => {
    if (!llmConfig) return facts.join("; ");

    const promptKey = depth === 0 ? "d0_to_d1" : "d1_to_d2";
    const prompt = COMPRESSION_PROMPTS[promptKey] + facts.map((f) => `- ${f}`).join("\n");

    return chatCompletion(llmConfig, prompt);
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

  log.info("[cross-session-sync] registering hooks (llm_input, llm_output, before_prompt_build)");

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
          return { prependContext: `# Cross-Session Context\n\n${block}\n\n# End Cross-Session Context\n\n` };
        }
      } catch (err) {
        log.error(`[cross-session-sync] injection error: ${err}`);
      }
      return undefined;
    });
  }

  // Hook: extract facts using llm_input (user prompt) + llm_output (assistant response).
  // Also listen to message_received as a fallback for capturing the original user text.
  if (extractionEnabled && (api as any).on) {
    const pendingUserPrompts = new Map<string, string>();

    // llm_input: capture user prompt per session
    (api as any).on("llm_input", (
      event: { prompt: string; sessionId: string; systemPrompt?: string; historyMessages?: unknown[] },
      ctx: { sessionKey?: string; channelId?: string; messageProvider?: string },
    ) => {
      const sessionKey = ctx?.sessionKey || "";
      const prompt = event.prompt || "";

      // Skip internal sessions (slug generators, etc.)
      if (sessionKey.startsWith("temp:")) return;

      // Strip our injected context prefix to get the real user prompt.
      // Use the end-of-block marker for reliable detection, falling back
      // to heuristic double-newline scanning if the marker is absent.
      let userPrompt = prompt;
      if (userPrompt.startsWith("# Cross-Session Context")) {
        const markerIdx = userPrompt.indexOf("# End Cross-Session Context");
        if (markerIdx > 0) {
          userPrompt = userPrompt.slice(markerIdx + "# End Cross-Session Context".length).trim();
        } else {
          const endIdx = userPrompt.indexOf("\n\n", userPrompt.indexOf("\n\n") + 2);
          if (endIdx > 0) {
            userPrompt = userPrompt.slice(endIdx).trim();
          }
        }
      }

      if (sessionKey && userPrompt) {
        log.info(`[cross-session-sync] llm_input session=${sessionKey} channel=${ctx?.channelId || ctx?.messageProvider || "?"} prompt="${userPrompt.slice(0, 80)}"`);
        pendingUserPrompts.set(sessionKey, userPrompt);
      }
    });

    // llm_output: extract facts when we have both user + assistant messages
    (api as any).on("llm_output", (
      event: { assistantTexts: string[]; sessionId: string },
      ctx: { sessionKey?: string; channelId?: string; messageProvider?: string },
    ) => {
      const sessionKey = ctx?.sessionKey || "";
      const channelId = ctx?.channelId || ctx?.messageProvider || "";

      // Skip internal sessions
      if (sessionKey.startsWith("temp:")) return;

      const userMessage = pendingUserPrompts.get(sessionKey) || "";
      const assistantMessage = (event.assistantTexts || []).join("\n");

      pendingUserPrompts.delete(sessionKey);

      if (!userMessage) return;

      // Deduplication
      const messageKey = `${sessionKey}:${userMessage}`;
      if (messageKey === lastProcessedMessageKey) return;
      lastProcessedMessageKey = messageKey;

      log.info(`[cross-session-sync] extracting session=${sessionKey} channel=${channelId} user="${userMessage.slice(0, 60)}" assistant="${assistantMessage.slice(0, 60)}"`);

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
  hooksRegistered = false;
}
