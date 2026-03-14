import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Extractor } from "../src/extractor.js";
import { KnowledgeStore } from "../src/store.js";
import type { SyncConfig, TurnData } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { unlinkSync } from "fs";

const TEST_DB = `/tmp/test-extractor-${Date.now()}.sqlite`;

describe("Extractor", () => {
  let store: KnowledgeStore;
  let extractor: Extractor;

  const mockClassifierFn = async (userMsg: string, _assistantMsg: string) => {
    if (userMsg.includes("meeting")) {
      return [{ fact: "Meeting with Acme on Thursday", category: "schedule" as const, confidence: 0.9 }];
    }
    if (userMsg.includes("favorite color")) {
      return [{ fact: "Favorite color is blue", category: "preference" as const, confidence: 0.85 }];
    }
    return null;
  };

  const config: SyncConfig = {
    ...DEFAULT_CONFIG,
    dbPath: TEST_DB,
    classifierFn: mockClassifierFn,
  };

  beforeEach(() => {
    store = new KnowledgeStore(TEST_DB);
    extractor = new Extractor(store, config);
  });

  afterEach(() => {
    store.close();
    try {
      unlinkSync(TEST_DB);
      unlinkSync(TEST_DB + "-wal");
      unlinkSync(TEST_DB + "-shm");
    } catch {
      // ignore
    }
  });

  it("extracts knowledge from a meaningful turn", async () => {
    const turn: TurnData = {
      userMessage: "My meeting with Acme Corp was moved to Thursday",
      assistantMessage: "Got it, I've noted the meeting change.",
      sessionKey: "session-1",
      channel: "whatsapp",
    };

    const nuggets = await extractor.extract(turn);
    expect(nuggets).toHaveLength(1);
    expect(nuggets[0].fact).toBe("Meeting with Acme on Thursday");
    expect(nuggets[0].category).toBe("schedule");
  });

  it("skips noisy messages", async () => {
    const turn: TurnData = {
      userMessage: "lol ok",
      assistantMessage: "Ha!",
      sessionKey: "session-1",
      channel: "whatsapp",
    };

    const nuggets = await extractor.extract(turn);
    expect(nuggets).toHaveLength(0);
  });

  it("skips when classifier returns null", async () => {
    const turn: TurnData = {
      userMessage: "What is the weather like outside today please",
      assistantMessage: "I don't have access to weather data.",
      sessionKey: "session-1",
      channel: "slack",
    };

    const nuggets = await extractor.extract(turn);
    expect(nuggets).toHaveLength(0);
  });

  it("stores extracted nuggets in the database", async () => {
    const turn: TurnData = {
      userMessage: "My favorite color is definitely blue these days",
      assistantMessage: "Noted!",
      sessionKey: "session-1",
      channel: "whatsapp",
    };

    const nuggets = await extractor.extract(turn);
    expect(nuggets).toHaveLength(1);

    const stored = store.getNuggetById(nuggets[0].id);
    expect(stored).toBeDefined();
    expect(stored!.fact).toBe("Favorite color is blue");
  });
});
