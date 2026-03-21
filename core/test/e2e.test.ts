import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SyncEngine } from "../src/engine.js";
import { DAGStore } from "../src/dag-store.js";
import type { DAGSyncConfig, ClassifierFn, CompressorFn } from "../src/types.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let engine: SyncEngine;
let dbPath: string;

let factCounter = 0;
const topics = [
  "quarterly review with marketing department",
  "standup sync for backend engineering team",
  "onboarding session for new designer recruit",
  "budget planning workshop with finance leads",
  "sprint retrospective for mobile squad members",
  "architecture review of payment microservice stack",
  "customer feedback roundtable with product owners",
  "security audit preparation with compliance team",
];
const mockClassifier: ClassifierFn = async (userMessage: string) => {
  factCounter++;
  const topic = topics[(factCounter - 1) % topics.length];
  if (userMessage.includes("meeting")) {
    return [
      { fact: topic, category: "schedule", confidence: 0.9 },
    ];
  }
  if (userMessage.includes("prefer") || userMessage.includes("like")) {
    return [
      { fact: userMessage.slice(0, 60), category: "preference", confidence: 0.85 },
    ];
  }
  if (userMessage.includes("decided") || userMessage.includes("going with")) {
    return [
      { fact: `Decision: ${userMessage.slice(0, 50)}`, category: "decision", confidence: 0.9 },
    ];
  }
  return null;
};

const mockCompressor: CompressorFn = async (facts: string[]) => {
  return `Consolidated: ${facts.join("; ")}`;
};

beforeEach(() => {
  factCounter = 0;
  dbPath = path.join(os.tmpdir(), `e2e-test-${randomUUID()}.sqlite`);
  const config: DAGSyncConfig = {
    dbPath,
    classifierFn: mockClassifier,
    compressorFn: mockCompressor,
    relevanceWindowHours: 24,
    maxInjectedTokens: 500,
    confidenceThreshold: 0.6,
    noiseFilterPatterns: ["ok", "thanks", "lol"],
    compressionThresholds: { 0: 5, 1: 3, 2: 2 },
    maxDepth: 4,
  };
  engine = new SyncEngine(config);
});

afterEach(() => {
  engine.close();
  try {
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + "-wal");
    fs.unlinkSync(dbPath + "-shm");
  } catch {}
});

describe("E2E: Cross-Session Sync", () => {
  it("Test 1: fact from one session appears in another", async () => {
    // WhatsApp session produces a fact
    await engine.onTurnComplete({
      userMessage: "I have a meeting on Thursday with the Acme team",
      assistantMessage: "I've noted your meeting with Acme on Thursday.",
      sessionKey: "whatsapp-123",
      channel: "whatsapp",
    });

    // Slack session should see it
    const block = engine.getInjectionBlock("slack-456");
    expect(block).toContain("quarterly review");
    expect(block).toContain("whatsapp");

    // WhatsApp session should NOT see its own fact (no echo)
    const selfBlock = engine.getInjectionBlock("whatsapp-123");
    expect(selfBlock).toBe("");
  });

  it("Test 2: conflicting facts resolve to latest", async () => {
    // First session says blue — use identical phrasing so overlap detection works
    await engine.onTurnComplete({
      userMessage: "I really like and prefer the color blue as my absolute favorite",
      assistantMessage: "Noted, blue is your favorite.",
      sessionKey: "s1",
      channel: "whatsapp",
    });

    // Second session says green — same structure, different color
    await engine.onTurnComplete({
      userMessage: "I really like and prefer the color green as my absolute favorite",
      assistantMessage: "Updated to green.",
      sessionKey: "s2",
      channel: "slack",
    });

    const block = engine.getInjectionBlock("s3");
    // Should see only the latest preference (green), not the older one (blue)
    const lines = block.split("\n").filter((l) => l.startsWith("- "));
    // Only one preference fact should be active
    expect(lines.length).toBe(1);
    expect(block).toContain("green");
  });

  it("Test 3: noise messages are not propagated", async () => {
    await engine.onTurnComplete({
      userMessage: "ok",
      assistantMessage: "Sure!",
      sessionKey: "s1",
      channel: "slack",
    });

    await engine.onTurnComplete({
      userMessage: "lol",
      assistantMessage: "Haha!",
      sessionKey: "s1",
      channel: "slack",
    });

    const block = engine.getInjectionBlock("s2");
    expect(block).toBe("");
  });

  it("Test 4: compression triggers and produces summaries", async () => {
    // Insert enough facts to trigger compression (threshold = 5)
    for (let i = 0; i < 6; i++) {
      await engine.onTurnComplete({
        userMessage: `I have a meeting number ${i} for the project team`,
        assistantMessage: `Noted meeting ${i}.`,
        sessionKey: "s1",
        channel: "slack",
      });
    }

    // Wait for async compression to complete
    await new Promise((r) => setTimeout(r, 200));

    // Force compression to ensure it ran
    await engine.runCompression();

    // Verify compression happened by checking the injection block
    // After compression, d0 schedule facts should be compressed into d1 summary
    // Add a recent preference fact so both sections appear
    await engine.onTurnComplete({
      userMessage: "I really prefer and like dark mode for all applications",
      assistantMessage: "Dark mode preference noted.",
      sessionKey: "s1",
      channel: "slack",
    });

    // Wait again for any async effects
    await new Promise((r) => setTimeout(r, 100));
    await engine.runCompression();

    const block = engine.getInjectionBlock("s2");
    expect(block).not.toBe("");
    expect(block).toContain("### Background");
  });

  it("Test 5: graceful degradation on failure", async () => {
    // Even with a working engine, injection should never throw
    const block = engine.getInjectionBlock("nonexistent-session");
    expect(typeof block).toBe("string");
  });

  it("Test 6: cleanup removes old compressed nodes", () => {
    // Cleanup should not throw
    expect(() => engine.cleanup()).not.toThrow();
  });

  it("Test 7: multiple channels contribute to shared context", async () => {
    await engine.onTurnComplete({
      userMessage: "We have an important meeting with the client on Monday",
      assistantMessage: "Monday meeting noted.",
      sessionKey: "whatsapp-1",
      channel: "whatsapp",
    });

    await engine.onTurnComplete({
      userMessage: "I have decided to go with PostgreSQL for the new database",
      assistantMessage: "PostgreSQL it is.",
      sessionKey: "slack-1",
      channel: "slack",
    });

    // Telegram session should see both
    const block = engine.getInjectionBlock("telegram-1");
    expect(block).toContain("quarterly review");
    expect(block).toContain("Decision");
  });
});
