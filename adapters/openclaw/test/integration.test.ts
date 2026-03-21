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

function createMockApi(configOverrides: Record<string, unknown> = {}) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const services = new Map<string, { interval: number; fn: () => void }>();

  // Ensure the db directory exists
  fs.mkdirSync(DB_DIR, { recursive: true });

  const chatMock = mock(() => Promise.resolve("null"));

  return {
    api: {
      agentId: TEST_AGENT_ID,
      config: configOverrides,
      llm: {
        chat: chatMock,
      },
      hooks: {
        on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
          hooks.set(event, handler);
        }),
      },
      services: {
        register: mock((name: string, service: { interval: number; fn: () => void }) => {
          services.set(name, service);
        }),
      },
    },
    hooks,
    services,
  };
}

describe("OpenClaw Adapter", () => {
  afterEach(() => {
    deactivate();
    cleanupDb();
  });

  it("registers before_prompt_build and message:preprocessed hooks", () => {
    const { api, hooks } = createMockApi();
    register(api);

    expect(hooks.has("before_prompt_build")).toBe(true);
    expect(hooks.has("message:preprocessed")).toBe(true);
    expect(api.hooks.on).toHaveBeenCalledTimes(2);
  });

  it("registers cleanup service", () => {
    const { api, services } = createMockApi();
    register(api);

    expect(services.has("cross-session-sync-cleanup")).toBe(true);
    expect(api.services.register).toHaveBeenCalledTimes(1);
  });

  it("before_prompt_build handler returns context from engine", async () => {
    const { api, hooks } = createMockApi();

    // Mock classifier to return a fact
    api.llm.chat.mockImplementation(() =>
      Promise.resolve(
        JSON.stringify([{
          fact: "Meeting on Thursday",
          category: "schedule",
          entity: "acme meeting",
          confidence: 0.9,
        }])
      )
    );

    register(api);

    // Simulate a message:preprocessed event (session-1)
    const msgHandler = hooks.get("message:preprocessed")!;
    await msgHandler({
      userMessage: "My meeting is on Thursday",
      assistantMessage: "Noted!",
      sessionKey: "session-1",
      channel: "whatsapp",
    });

    // Small delay for async processing
    await new Promise((r) => setTimeout(r, 50));

    // Now check injection for session-2
    const promptHandler = hooks.get("before_prompt_build")!;
    const result = promptHandler({ sessionKey: "session-2" }) as { prependSystemContext?: string } | undefined;

    expect(result).toBeDefined();
    expect(result!.prependSystemContext).toContain("Meeting on Thursday");
    expect(result!.prependSystemContext).toContain("Cross-Session Context");
  });

  it("respects extractionEnabled=false config", () => {
    const { api, hooks } = createMockApi({ extractionEnabled: false });
    register(api);

    expect(hooks.has("before_prompt_build")).toBe(true);
    expect(hooks.has("message:preprocessed")).toBe(false);
  });

  it("respects injectionEnabled=false config", () => {
    const { api, hooks } = createMockApi({ injectionEnabled: false });
    register(api);

    expect(hooks.has("before_prompt_build")).toBe(false);
    expect(hooks.has("message:preprocessed")).toBe(true);
  });
});
