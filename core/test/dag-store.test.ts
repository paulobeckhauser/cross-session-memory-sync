import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DAGStore } from "../src/dag-store.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let store: DAGStore;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `dag-test-${randomUUID()}.sqlite`);
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

describe("DAGStore", () => {
  describe("insertFact", () => {
    it("should insert a d0 fact", () => {
      store.insertFact({
        id: "fact-1",
        content: "User likes dark mode",
        category: "preference",
        confidence: 0.9,
        sourceSession: "session-1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      const node = store.getNodeById("fact-1");
      expect(node).not.toBeNull();
      expect(node!.depth).toBe(0);
      expect(node!.content).toBe("User likes dark mode");
      expect(node!.category).toBe("preference");
      expect(node!.isCompressed).toBe(false);
    });
  });

  describe("getActiveNodes", () => {
    it("should return only active non-compressed nodes", () => {
      store.insertFact({
        id: "f1",
        content: "Fact 1",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });
      store.insertFact({
        id: "f2",
        content: "Fact 2",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s2",
        sourceChannel: "telegram",
        createdAt: new Date().toISOString(),
      });

      const active = store.getActiveNodes();
      expect(active.length).toBe(2);
    });

    it("should exclude specified session", () => {
      store.insertFact({
        id: "f1",
        content: "Fact 1",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });
      store.insertFact({
        id: "f2",
        content: "Fact 2",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s2",
        sourceChannel: "telegram",
        createdAt: new Date().toISOString(),
      });

      const active = store.getActiveNodes("s1");
      expect(active.length).toBe(1);
      expect(active[0].sourceSession).toBe("s2");
    });

    it("should exclude superseded nodes", () => {
      store.insertFact({
        id: "f1",
        content: "Favorite color is blue",
        category: "preference",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });
      store.insertFact({
        id: "f2",
        content: "Favorite color is green",
        category: "preference",
        confidence: 0.9,
        sourceSession: "s2",
        sourceChannel: "telegram",
        createdAt: new Date().toISOString(),
      });
      store.supersede("f1", "f2");

      const active = store.getActiveNodes();
      expect(active.length).toBe(1);
      expect(active[0].id).toBe("f2");
    });
  });

  describe("insertSummary", () => {
    it("should create a summary and mark children compressed", () => {
      store.insertFact({
        id: "f1",
        content: "Meeting Monday",
        category: "schedule",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });
      store.insertFact({
        id: "f2",
        content: "Meeting Wednesday",
        category: "schedule",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      store.insertSummary({
        id: "summary-1",
        depth: 1,
        content: "Meetings on Monday and Wednesday",
        category: "schedule",
        createdAt: new Date().toISOString(),
        childIds: ["f1", "f2"],
      });

      // Summary exists
      const summary = store.getNodeById("summary-1");
      expect(summary).not.toBeNull();
      expect(summary!.depth).toBe(1);

      // Children are compressed
      const f1 = store.getNodeById("f1");
      expect(f1!.isCompressed).toBe(true);
      expect(f1!.parentId).toBe("summary-1");

      // Active nodes should only show the summary
      const active = store.getActiveNodes();
      expect(active.length).toBe(1);
      expect(active[0].id).toBe("summary-1");
    });
  });

  describe("getLineage", () => {
    it("should return child nodes for a summary", () => {
      store.insertFact({
        id: "f1",
        content: "Fact A",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });
      store.insertFact({
        id: "f2",
        content: "Fact B",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      store.insertSummary({
        id: "sum-1",
        depth: 1,
        content: "Summary of A and B",
        category: "fact",
        createdAt: new Date().toISOString(),
        childIds: ["f1", "f2"],
      });

      const lineage = store.getLineage("sum-1");
      expect(lineage.length).toBe(2);
      expect(lineage.map((n) => n.id).sort()).toEqual(["f1", "f2"]);
    });
  });

  describe("getUncompressedNodes", () => {
    it("should return nodes at specific depth and category", () => {
      store.insertFact({
        id: "f1",
        content: "Pref 1",
        category: "preference",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });
      store.insertFact({
        id: "f2",
        content: "Schedule 1",
        category: "schedule",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      const prefs = store.getUncompressedNodes(0, "preference");
      expect(prefs.length).toBe(1);
      expect(prefs[0].category).toBe("preference");
    });
  });

  describe("supersede", () => {
    it("should mark a node as superseded", () => {
      store.insertFact({
        id: "f1",
        content: "Old fact",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      store.supersede("f1", "f2");

      const node = store.getNodeById("f1");
      expect(node!.supersededBy).toBe("f2");
    });
  });

  describe("cleanup", () => {
    it("should delete old compressed nodes", () => {
      const oldDate = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();

      store.insertFact({
        id: "f1",
        content: "Old fact",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: oldDate,
      });
      store.insertFact({
        id: "f2",
        content: "Old fact 2",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: oldDate,
      });

      // Compress them
      store.insertSummary({
        id: "sum-1",
        depth: 1,
        content: "Summary",
        category: "fact",
        createdAt: oldDate,
        childIds: ["f1", "f2"],
      });

      const deleted = store.cleanup(48);
      expect(deleted).toBeGreaterThan(0);
    });

    it("should not delete active uncompressed nodes", () => {
      store.insertFact({
        id: "f1",
        content: "Active recent fact",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      const deleted = store.cleanup(48);
      expect(deleted).toBe(0);
      expect(store.getNodeById("f1")).not.toBeNull();
    });
  });

  describe("nodeCount", () => {
    it("should return total node count", () => {
      expect(store.nodeCount()).toBe(0);

      store.insertFact({
        id: "f1",
        content: "Fact",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      expect(store.nodeCount()).toBe(1);
    });
  });
});
