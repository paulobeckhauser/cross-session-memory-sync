import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Injector } from "../src/injector.js";
import { KnowledgeStore } from "../src/store.js";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";

const TEST_DB = `/tmp/test-injector-${Date.now()}.sqlite`;

describe("Injector", () => {
  let store: KnowledgeStore;
  let injector: Injector;

  beforeEach(() => {
    store = new KnowledgeStore(TEST_DB);
    injector = new Injector(store, 24, 500);
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

  it("returns empty string when no nuggets exist", () => {
    const block = injector.getContextBlock("session-1");
    expect(block).toBe("");
  });

  it("formats nuggets into a context block", () => {
    store.insertNugget({
      id: randomUUID(),
      fact: "Meeting with Acme on Thursday",
      category: "schedule",
      confidence: 0.9,
      sourceSession: "session-1",
      sourceChannel: "whatsapp",
      createdAt: new Date().toISOString(),
    });

    const block = injector.getContextBlock("session-2");
    expect(block).toContain("## Cross-Session Context");
    expect(block).toContain("whatsapp");
    expect(block).toContain("Meeting with Acme on Thursday");
  });

  it("excludes nuggets from the requesting session", () => {
    store.insertNugget({
      id: randomUUID(),
      fact: "My own fact",
      category: "fact",
      confidence: 0.9,
      sourceSession: "session-1",
      sourceChannel: "slack",
      createdAt: new Date().toISOString(),
    });

    const block = injector.getContextBlock("session-1");
    expect(block).toBe("");
  });

  it("respects token budget", () => {
    // Insert many nuggets
    for (let i = 0; i < 50; i++) {
      store.insertNugget({
        id: randomUUID(),
        fact: `This is fact number ${i} which contains some substantial text content for testing`,
        category: "fact",
        confidence: 0.9,
        sourceSession: "session-1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });
    }

    const block = injector.getContextBlock("session-2", 100);
    // Should be truncated well before all 50 nuggets
    const lineCount = block.split("\n").length;
    expect(lineCount).toBeLessThan(50);
  });

  it("shows age of nuggets", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    store.insertNugget({
      id: randomUUID(),
      fact: "Recent fact",
      category: "fact",
      confidence: 0.9,
      sourceSession: "session-1",
      sourceChannel: "telegram",
      createdAt: fiveMinAgo,
    });

    const block = injector.getContextBlock("session-2");
    expect(block).toContain("5min ago");
  });
});
