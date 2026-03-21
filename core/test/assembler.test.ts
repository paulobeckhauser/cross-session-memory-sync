import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DAGStore } from "../src/dag-store.js";
import { Assembler } from "../src/assembler.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let store: DAGStore;
let dbPath: string;
let assembler: Assembler;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `assembler-test-${randomUUID()}.sqlite`);
  store = new DAGStore(dbPath);
  assembler = new Assembler(store);
});

afterEach(() => {
  store.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + "-wal");
    fs.unlinkSync(dbPath + "-shm");
  } catch {}
});

describe("Assembler", () => {
  describe("assembleContext", () => {
    it("should return empty string when no nodes exist", () => {
      const result = assembler.assembleContext("session-1");
      expect(result).toBe("");
    });

    it("should include recent d0 facts", () => {
      store.insertFact({
        id: "f1",
        content: "Acme meeting moved to Thursday",
        category: "schedule",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      const result = assembler.assembleContext("s2");
      expect(result).toContain("## Cross-Session Context");
      expect(result).toContain("### Recent");
      expect(result).toContain("Acme meeting moved to Thursday");
      expect(result).toContain("slack");
    });

    it("should exclude current session facts", () => {
      store.insertFact({
        id: "f1",
        content: "My own fact",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      const result = assembler.assembleContext("s1");
      expect(result).toBe("");
    });

    it("should include background summaries", () => {
      // Insert and compress some facts
      store.insertFact({
        id: "f1",
        content: "Likes dark mode",
        category: "preference",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });
      store.insertFact({
        id: "f2",
        content: "Prefers VS Code",
        category: "preference",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      store.insertSummary({
        id: "sum-1",
        depth: 1,
        content: "User prefers dark mode and VS Code",
        category: "preference",
        createdAt: new Date().toISOString(),
        childIds: ["f1", "f2"],
      });

      // Add a recent uncompressed fact from different session
      store.insertFact({
        id: "f3",
        content: "New meeting tomorrow",
        category: "schedule",
        confidence: 0.9,
        sourceSession: "s2",
        sourceChannel: "telegram",
        createdAt: new Date().toISOString(),
      });

      const result = assembler.assembleContext("s3");
      expect(result).toContain("### Recent");
      expect(result).toContain("New meeting tomorrow");
      expect(result).toContain("### Background");
      expect(result).toContain("User prefers dark mode and VS Code");
    });

    it("should respect token budget", () => {
      // Insert many facts to exceed budget
      for (let i = 0; i < 50; i++) {
        store.insertFact({
          id: `f${i}`,
          content: `This is a fairly long fact number ${i} with some extra detail to consume tokens`,
          category: "fact",
          confidence: 0.9,
          sourceSession: "s1",
          sourceChannel: "slack",
          createdAt: new Date().toISOString(),
        });
      }

      const result = assembler.assembleContext("s2", 100);
      // Should not include all 50 facts
      const lineCount = result.split("\n").length;
      expect(lineCount).toBeLessThan(50);
    });

    it("should show Recent section before Background", () => {
      store.insertFact({
        id: "f1",
        content: "Recent fact",
        category: "fact",
        confidence: 0.9,
        sourceSession: "s1",
        sourceChannel: "slack",
        createdAt: new Date().toISOString(),
      });

      // Create a summary (background)
      store.insertFact({
        id: "f2",
        content: "Old 1",
        category: "preference",
        confidence: 0.9,
        sourceSession: "s2",
        sourceChannel: "telegram",
        createdAt: new Date().toISOString(),
      });
      store.insertFact({
        id: "f3",
        content: "Old 2",
        category: "preference",
        confidence: 0.9,
        sourceSession: "s2",
        sourceChannel: "telegram",
        createdAt: new Date().toISOString(),
      });
      store.insertSummary({
        id: "sum-1",
        depth: 1,
        content: "Background preferences summary",
        category: "preference",
        createdAt: new Date().toISOString(),
        childIds: ["f2", "f3"],
      });

      const result = assembler.assembleContext("s3");
      const recentIdx = result.indexOf("### Recent");
      const bgIdx = result.indexOf("### Background");
      expect(recentIdx).toBeLessThan(bgIdx);
    });
  });
});
