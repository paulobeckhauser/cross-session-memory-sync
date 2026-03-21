import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DAGStore } from "../src/dag-store.js";
import { Compressor } from "../src/compressor.js";
import type { CompressorFn } from "../src/types.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let store: DAGStore;
let dbPath: string;

const mockCompressorFn: CompressorFn = async (facts: string[]) => {
  return `Summary of ${facts.length} facts: ${facts.join("; ")}`;
};

const failingCompressorFn: CompressorFn = async () => {
  throw new Error("LLM unavailable");
};

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `compressor-test-${randomUUID()}.sqlite`);
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

function insertFacts(count: number, category: string = "preference") {
  for (let i = 0; i < count; i++) {
    store.insertFact({
      id: `fact-${i}`,
      content: `Fact number ${i}`,
      category: category as any,
      confidence: 0.9,
      sourceSession: "s1",
      sourceChannel: "slack",
      createdAt: new Date().toISOString(),
    });
  }
}

describe("Compressor", () => {
  describe("needsCompression", () => {
    it("should detect when threshold is exceeded", () => {
      const compressor = new Compressor(store, mockCompressorFn, { 0: 5 }, 4);

      insertFacts(6);
      const pending = compressor.needsCompression();
      expect(pending.length).toBe(1);
      expect(pending[0].depth).toBe(0);
      expect(pending[0].category).toBe("preference");
      expect(pending[0].count).toBe(6);
    });

    it("should return empty when below threshold", () => {
      const compressor = new Compressor(store, mockCompressorFn, { 0: 20 }, 4);

      insertFacts(5);
      const pending = compressor.needsCompression();
      expect(pending.length).toBe(0);
    });

    it("should detect per-category thresholds", () => {
      const compressor = new Compressor(store, mockCompressorFn, { 0: 3 }, 4);

      insertFacts(4, "preference");
      for (let i = 0; i < 4; i++) {
        store.insertFact({
          id: `sched-${i}`,
          content: `Schedule ${i}`,
          category: "schedule",
          confidence: 0.9,
          sourceSession: "s1",
          sourceChannel: "slack",
          createdAt: new Date().toISOString(),
        });
      }

      const pending = compressor.needsCompression();
      expect(pending.length).toBe(2);
    });
  });

  describe("compress", () => {
    it("should compress d0 nodes into a d1 summary", async () => {
      const compressor = new Compressor(store, mockCompressorFn, { 0: 3 }, 4);

      insertFacts(5);

      const summary = await compressor.compress(0, "preference");
      expect(summary).not.toBeNull();
      expect(summary!.depth).toBe(1);
      expect(summary!.content).toContain("Summary of 5 facts");

      // Original facts should be compressed
      const active = store.getActiveNodes();
      expect(active.length).toBe(1);
      expect(active[0].depth).toBe(1);

      // Lineage should be preserved
      const lineage = store.getLineage(summary!.id);
      expect(lineage.length).toBe(5);
    });

    it("should return null for insufficient nodes", async () => {
      const compressor = new Compressor(store, mockCompressorFn, { 0: 3 }, 4);

      insertFacts(1);
      const summary = await compressor.compress(0, "preference");
      expect(summary).toBeNull();
    });
  });

  describe("escalation on failure", () => {
    it("should fall back to deterministic truncation", async () => {
      const compressor = new Compressor(store, failingCompressorFn, { 0: 3 }, 4);

      insertFacts(6);

      const summary = await compressor.compress(0, "preference");
      expect(summary).not.toBeNull();
      // Should contain truncated facts (deterministic fallback)
      expect(summary!.content).toContain("Fact number");
    });
  });

  describe("runCompressionPass", () => {
    it("should compress all pending categories", async () => {
      const compressor = new Compressor(store, mockCompressorFn, { 0: 3 }, 4);

      insertFacts(4, "preference");
      for (let i = 0; i < 4; i++) {
        store.insertFact({
          id: `sched-${i}`,
          content: `Schedule item ${i}`,
          category: "schedule",
          confidence: 0.9,
          sourceSession: "s1",
          sourceChannel: "slack",
          createdAt: new Date().toISOString(),
        });
      }

      await compressor.runCompressionPass();

      const active = store.getActiveNodes();
      // Should have 2 summaries (one per category)
      expect(active.length).toBe(2);
      expect(active.every((n) => n.depth === 1)).toBe(true);
    });
  });

  describe("multi-level compression", () => {
    it("should compress d1 nodes into d2", async () => {
      const compressor = new Compressor(
        store,
        mockCompressorFn,
        { 0: 3, 1: 2 },
        4
      );

      // Create enough d0 facts to generate multiple d1 summaries
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 4; i++) {
          store.insertFact({
            id: `f-${batch}-${i}`,
            content: `Preference batch ${batch} item ${i}`,
            category: "preference",
            confidence: 0.9,
            sourceSession: "s1",
            sourceChannel: "slack",
            createdAt: new Date().toISOString(),
          });
        }
        // Compress d0 → d1
        await compressor.compress(0, "preference");
      }

      // Now we have 3 d1 nodes, threshold is 2
      const pending = compressor.needsCompression();
      const d1Pending = pending.find((p) => p.depth === 1);
      expect(d1Pending).toBeDefined();

      // Compress d1 → d2
      const d2Summary = await compressor.compress(1, "preference");
      expect(d2Summary).not.toBeNull();
      expect(d2Summary!.depth).toBe(2);
    });
  });
});
