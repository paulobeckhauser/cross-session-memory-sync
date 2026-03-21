import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Extractor } from "../src/extractor.js";
import { DAGStore } from "../src/dag-store.js";
import type { ClassifierFn, ClassifiedNugget } from "../src/types.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let store: DAGStore;
let dbPath: string;

const mockClassifier: ClassifierFn = async (userMessage: string) => {
  if (userMessage.includes("meeting")) {
    return [
      {
        fact: "Meeting scheduled for Thursday",
        category: "schedule",
        confidence: 0.9,
      },
    ];
  }
  if (userMessage.includes("favorite color")) {
    return [
      {
        fact: `Favorite color is ${userMessage.includes("green") ? "green" : "blue"}`,
        category: "preference",
        confidence: 0.85,
      },
    ];
  }
  return null;
};

const lowConfidenceClassifier: ClassifierFn = async () => {
  return [
    {
      fact: "Low confidence fact",
      category: "fact",
      confidence: 0.3,
    },
  ];
};

const failingClassifier: ClassifierFn = async () => {
  throw new Error("LLM failed");
};

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `extractor-test-${randomUUID()}.sqlite`);
  store = new DAGStore(dbPath);
});

afterEach(() => {
  store.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + "-wal");
    fs.unlinkSync(dbPath + "-shm");
  } catch {}
});

describe("Extractor", () => {
  it("should extract facts from meaningful messages", async () => {
    const extractor = new Extractor(store, mockClassifier, ["ok", "thanks"], 0.6);

    const count = await extractor.extract({
      userMessage: "I have a meeting on Thursday with Acme Corp",
      assistantMessage: "I've noted your meeting.",
      sessionKey: "s1",
      channel: "slack",
    });

    expect(count).toBe(1);
    expect(store.nodeCount()).toBe(1);

    const nodes = store.getActiveNodes();
    expect(nodes[0].content).toBe("Meeting scheduled for Thursday");
    expect(nodes[0].category).toBe("schedule");
    expect(nodes[0].sourceSession).toBe("s1");
    expect(nodes[0].sourceChannel).toBe("slack");
  });

  it("should skip noise messages", async () => {
    const extractor = new Extractor(store, mockClassifier, ["ok", "thanks"], 0.6);

    const count = await extractor.extract({
      userMessage: "ok",
      assistantMessage: "Got it.",
      sessionKey: "s1",
      channel: "slack",
    });

    expect(count).toBe(0);
    expect(store.nodeCount()).toBe(0);
  });

  it("should skip short messages", async () => {
    const extractor = new Extractor(store, mockClassifier, [], 0.6);

    const count = await extractor.extract({
      userMessage: "hi there",
      assistantMessage: "Hello!",
      sessionKey: "s1",
      channel: "slack",
    });

    expect(count).toBe(0);
  });

  it("should skip low confidence facts", async () => {
    const extractor = new Extractor(store, lowConfidenceClassifier, [], 0.6);

    const count = await extractor.extract({
      userMessage: "I might like some kind of thing or whatever",
      assistantMessage: "Interesting thought.",
      sessionKey: "s1",
      channel: "slack",
    });

    expect(count).toBe(0);
  });

  it("should handle classifier failure gracefully", async () => {
    const extractor = new Extractor(store, failingClassifier, [], 0.6);

    const count = await extractor.extract({
      userMessage: "This is a meaningful message about meetings",
      assistantMessage: "Noted.",
      sessionKey: "s1",
      channel: "slack",
    });

    expect(count).toBe(0);
    expect(store.nodeCount()).toBe(0);
  });

  it("should supersede conflicting facts", async () => {
    const extractor = new Extractor(store, mockClassifier, [], 0.6);

    await extractor.extract({
      userMessage: "My favorite color is blue and I really like it",
      assistantMessage: "Blue is a nice color.",
      sessionKey: "s1",
      channel: "whatsapp",
    });

    await extractor.extract({
      userMessage: "Actually my favorite color is green now I changed my mind",
      assistantMessage: "Green is lovely too!",
      sessionKey: "s2",
      channel: "slack",
    });

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("green");
  });
});
