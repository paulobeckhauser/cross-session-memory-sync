import { describe, it, expect, afterEach, mock } from "bun:test";
import { register, deactivate } from "../src/index.js";
import { unlinkSync } from "fs";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const TEST_AGENT_ID = "test-agent-integration";
const DB_DIR = path.join(os.homedir(), ".openclaw", "memory");
const DB_PATH = path.join(DB_DIR, `${TEST_AGENT_ID}-knowledge-dag.sqlite`);

function cleanupDb() {
  try {
    unlinkSync(DB_PATH);
    unlinkSync(DB_PATH + "-wal");
    unlinkSync(DB_PATH + "-shm");
  } catch {
    // ignore
  }
}

function createMockApi(pluginConfigOverrides: Record<string, unknown> = {}) {
  const onHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const services = new Map<string, unknown>();

  // Ensure the db directory exists
  fs.mkdirSync(DB_DIR, { recursive: true });

  const registerHookMock = mock(
    (events: string | string[], handler: (...args: unknown[]) => unknown) => {
      const eventList = Array.isArray(events) ? events : [events];
      for (const event of eventList) {
        onHandlers.set(event, handler);
      }
    }
  );

  const registerServiceMock = mock((service: { id: string }) => {
    services.set(service.id, service);
  });

  const onMock = mock(
    (event: string, handler: (...args: unknown[]) => unknown) => {
      onHandlers.set(event, handler);
    }
  );

  return {
    api: {
      id: TEST_AGENT_ID,
      name: "Test Agent",
      pluginConfig: pluginConfigOverrides,
      config: {
        hooks: { internal: { enabled: true } },
      },
      registrationMode: "gateway",
      logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
      runtime: {
        agent: {
          runEmbeddedPiAgent: mock(() => Promise.resolve({ payloads: [] })),
          resolveAgentDir: mock(() => "/tmp/test-agent"),
        },
      },
      registerHook: registerHookMock,
      registerService: registerServiceMock,
      on: onMock,
    },
    hooks: onHandlers,
    services,
  };
}

describe("OpenClaw Adapter", () => {
  afterEach(() => {
    deactivate();
    cleanupDb();
  });

  it("registers llm event hooks and cleanup service", () => {
    const { api, hooks, services } = createMockApi();
    register(api as any);

    // The adapter registers llm_input, llm_output, and before_prompt_build via api.on()
    expect(hooks.has("before_prompt_build")).toBe(true);
    expect(hooks.has("llm_input")).toBe(true);
    expect(hooks.has("llm_output")).toBe(true);
    expect(services.has("cross-session-sync-cleanup")).toBe(true);
    expect(api.registerService).toHaveBeenCalledTimes(1);
  });

  it("before_prompt_build handler returns context from engine", async () => {
    const { api, hooks } = createMockApi();

    // Set OPENAI_API_KEY so the classifier is enabled
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";

    try {
      // Mock global fetch for OpenAI API calls
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify([
                      {
                        fact: "Meeting on Thursday",
                        category: "schedule",
                        entity: "acme meeting",
                        confidence: 0.9,
                      },
                    ]),
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
      ) as any;

      register(api as any);

      // Simulate llm_input (user message)
      const llmInputHandler = hooks.get("llm_input")!;
      llmInputHandler(
        { prompt: "My meeting is on Thursday", sessionId: "s1" },
        { sessionKey: "session-1", channelId: "whatsapp" }
      );

      // Simulate llm_output (assistant response)
      const llmOutputHandler = hooks.get("llm_output")!;
      await llmOutputHandler(
        { assistantTexts: ["Noted!"], sessionId: "s1" },
        { sessionKey: "session-1", channelId: "whatsapp" }
      );

      // Small delay for async processing
      await new Promise((r) => setTimeout(r, 100));

      // Now check injection for session-2
      const promptHandler = hooks.get("before_prompt_build")!;
      const result = promptHandler(
        { prompt: "", messages: [] },
        { sessionKey: "session-2", channelId: "slack" }
      ) as { prependContext?: string } | undefined;

      expect(result).toBeDefined();
      expect(result!.prependContext).toContain("Meeting on Thursday");
      expect(result!.prependContext).toContain("Cross-Session Context");

      globalThis.fetch = originalFetch;
    } finally {
      if (origKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = origKey;
      }
    }
  });

  it("respects extractionEnabled=false config", () => {
    const { api, hooks } = createMockApi({ extractionEnabled: false });
    register(api as any);

    // Injection hooks should still be registered
    expect(hooks.has("before_prompt_build")).toBe(true);
    // Extraction hooks should NOT be registered
    expect(hooks.has("llm_input")).toBe(false);
    expect(hooks.has("llm_output")).toBe(false);
  });

  it("respects injectionEnabled=false config", () => {
    const { api, hooks } = createMockApi({ injectionEnabled: false });
    register(api as any);

    // Injection hook should NOT be registered
    expect(hooks.has("before_prompt_build")).toBe(false);
    // Extraction hooks should still be registered
    expect(hooks.has("llm_input")).toBe(true);
    expect(hooks.has("llm_output")).toBe(true);
  });

  it("skips hook registration when hooks.internal.enabled is false", () => {
    const { api, hooks } = createMockApi();
    (api.config as any).hooks.internal.enabled = false;
    register(api as any);

    // No event hooks should be registered (only service)
    expect(hooks.has("before_prompt_build")).toBe(false);
    expect(hooks.has("llm_input")).toBe(false);
    expect(hooks.has("llm_output")).toBe(false);
  });
});
