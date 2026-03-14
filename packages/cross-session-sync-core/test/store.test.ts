import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeStore } from "../src/store.js";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";

const TEST_DB = `/tmp/test-store-${Date.now()}.sqlite`;

describe("KnowledgeStore", () => {
  let store: KnowledgeStore;

  beforeEach(() => {
    store = new KnowledgeStore(TEST_DB);
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

  function makeNugget(overrides: Partial<import("../src/types.js").KnowledgeNugget> = {}) {
    return {
      id: randomUUID(),
      fact: "Test fact",
      category: "fact" as const,
      confidence: 0.9,
      sourceSession: "session-1",
      sourceChannel: "whatsapp",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("inserts and retrieves a nugget", () => {
    const nugget = makeNugget();
    store.insertNugget(nugget);

    const result = store.getNuggetById(nugget.id);
    expect(result).toBeDefined();
    expect(result!.fact).toBe("Test fact");
    expect(result!.category).toBe("fact");
  });

  it("getActiveNuggets excludes the requesting session", () => {
    store.insertNugget(makeNugget({ sourceSession: "session-1" }));
    store.insertNugget(makeNugget({ sourceSession: "session-2" }));

    const results = store.getActiveNuggets("session-1", 24);
    expect(results).toHaveLength(1);
    expect(results[0].sourceSession).toBe("session-2");
  });

  it("getActiveNuggets excludes old nuggets", () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    store.insertNugget(makeNugget({ sourceSession: "session-2", createdAt: oldDate }));

    const results = store.getActiveNuggets("session-1", 24);
    expect(results).toHaveLength(0);
  });

  it("getActiveNuggets excludes superseded nuggets", () => {
    const nugget1 = makeNugget({ sourceSession: "session-2" });
    const nugget2 = makeNugget({ sourceSession: "session-2" });
    store.insertNugget(nugget1);
    store.insertNugget(nugget2);
    store.supersede(nugget1.id, nugget2.id);

    const results = store.getActiveNuggets("session-1", 24);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(nugget2.id);
  });

  it("supersede marks old nugget correctly", () => {
    const old = makeNugget();
    const newer = makeNugget();
    store.insertNugget(old);
    store.insertNugget(newer);
    store.supersede(old.id, newer.id);

    const result = store.getNuggetById(old.id);
    expect(result!.supersededBy).toBe(newer.id);
  });

  it("findConflicting returns most recent active nugget in category", () => {
    store.insertNugget(makeNugget({
      sourceSession: "session-1",
      category: "preference",
      fact: "Likes blue",
    }));

    const conflict = store.findConflicting("preference", "session-2");
    expect(conflict).toBeDefined();
    expect(conflict!.fact).toBe("Likes blue");
  });

  it("findConflicting ignores same session", () => {
    store.insertNugget(makeNugget({
      sourceSession: "session-1",
      category: "preference",
    }));

    const conflict = store.findConflicting("preference", "session-1");
    expect(conflict).toBeUndefined();
  });

  it("cleanup removes old nuggets", () => {
    const oldDate = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    store.insertNugget(makeNugget({ createdAt: oldDate }));
    store.insertNugget(makeNugget()); // recent

    const deleted = store.cleanup(48);
    expect(deleted).toBe(1);
  });
});
