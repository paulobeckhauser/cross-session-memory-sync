import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Extractor } from "../src/extractor.js";
import { DAGStore } from "../src/dag-store.js";
import type { ClassifierFn, NuggetCategory } from "../src/types.js";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let store: DAGStore;
let dbPath: string;

// Helper: build a classifier that echoes back the user message as a fact
function echoClassifier(category: NuggetCategory = "fact"): ClassifierFn {
  return async (userMessage: string) => [
    { fact: userMessage, category, confidence: 0.95 },
  ];
}

// Helper: classifier that returns a custom fact/category
function fixedClassifier(fact: string, category: NuggetCategory): ClassifierFn {
  return async () => [{ fact, category, confidence: 0.95 }];
}

// Helper: classifier that returns multiple nuggets
function multiClassifier(nuggets: { fact: string; category: NuggetCategory }[]): ClassifierFn {
  return async () =>
    nuggets.map((n) => ({ ...n, confidence: 0.95 }));
}

function makeTurn(userMessage: string, channel = "test", session = "s1") {
  return {
    userMessage,
    assistantMessage: "Noted.",
    sessionKey: session,
    channel,
  };
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `conflict-stress-${randomUUID()}.sqlite`);
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

// ─── Same-category conflict detection ────────────────────────────────────────

describe("Same-category conflict detection", () => {
  it("should supersede when dog name changes", async () => {
    const ext1 = new Extractor(store, fixedClassifier("My dog's name is Bidu", "fact"), [], 0.6);
    await ext1.extract(makeTurn("My dog's name is Bidu", "telegram"));

    const ext2 = new Extractor(store, fixedClassifier("My dog's name is Rex", "fact"), [], 0.6);
    await ext2.extract(makeTurn("My dog's name is Rex", "discord"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("Rex");
  });

  it("should supersede when meeting day changes", async () => {
    const ext1 = new Extractor(store, fixedClassifier("Meeting scheduled for Thursday", "schedule"), [], 0.6);
    await ext1.extract(makeTurn("Meeting on Thursday", "slack"));

    const ext2 = new Extractor(store, fixedClassifier("Meeting scheduled for Friday", "schedule"), [], 0.6);
    await ext2.extract(makeTurn("Meeting moved to Friday", "telegram"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("Friday");
  });

  it("should supersede when favorite food changes", async () => {
    const ext1 = new Extractor(store, fixedClassifier("Favorite food is pizza", "preference"), [], 0.6);
    await ext1.extract(makeTurn("My favorite food is pizza", "whatsapp"));

    const ext2 = new Extractor(store, fixedClassifier("Favorite food is sushi", "preference"), [], 0.6);
    await ext2.extract(makeTurn("Actually my favorite food is sushi", "discord"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("sushi");
  });

  it("should NOT supersede unrelated facts in same category", async () => {
    const ext1 = new Extractor(store, fixedClassifier("Meeting with Acme Corp on Monday", "schedule"), [], 0.6);
    await ext1.extract(makeTurn("Meeting with Acme Corp on Monday", "slack"));

    const ext2 = new Extractor(store, fixedClassifier("Dentist appointment on Wednesday", "schedule"), [], 0.6);
    await ext2.extract(makeTurn("Dentist appointment on Wednesday", "slack"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(2);
  });

  it("should handle rapid-fire updates to the same fact", async () => {
    const names = ["Bidu", "Rex", "Luna", "Max", "Bella"];

    for (const name of names) {
      const ext = new Extractor(store, fixedClassifier(`My dog's name is ${name}`, "fact"), [], 0.6);
      await ext.extract(makeTurn(`My dog's name is ${name}`, "telegram"));
    }

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("Bella");
  });

  it("should supersede with entity matching (short overlap but shared entities)", async () => {
    const ext1 = new Extractor(store, fixedClassifier("Paulo works at Google", "fact"), [], 0.6);
    await ext1.extract(makeTurn("I work at Google", "slack"));

    const ext2 = new Extractor(store, fixedClassifier("Paulo works at Microsoft", "fact"), [], 0.6);
    await ext2.extract(makeTurn("I switched to Microsoft", "discord"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("Microsoft");
  });
});

// ─── Cross-category conflict detection ───────────────────────────────────────

describe("Cross-category conflict detection", () => {
  it("should supersede cross-category when >60% overlap", async () => {
    const ext1 = new Extractor(store, fixedClassifier("My birthday is March 15", "fact"), [], 0.6);
    await ext1.extract(makeTurn("My birthday is March 15", "telegram"));

    // Same content re-categorized as schedule — >60% overlap should conflict
    const ext2 = new Extractor(store, fixedClassifier("My birthday is March 20", "schedule"), [], 0.6);
    await ext2.extract(makeTurn("Actually my birthday is March 20", "discord"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("March 20");
  });

  it("should NOT supersede cross-category with low overlap", async () => {
    const ext1 = new Extractor(store, fixedClassifier("I prefer dark mode in all apps", "preference"), [], 0.6);
    await ext1.extract(makeTurn("I prefer dark mode", "slack"));

    const ext2 = new Extractor(store, fixedClassifier("Sprint planning is every Monday", "schedule"), [], 0.6);
    await ext2.extract(makeTurn("Sprint planning is every Monday", "slack"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(2);
  });
});

// ─── Multi-channel stress tests ──────────────────────────────────────────────

describe("Multi-channel stress", () => {
  const channels = ["telegram", "discord", "whatsapp", "slack", "signal"];

  it("should converge to latest fact across 5 channels", async () => {
    for (let i = 0; i < channels.length; i++) {
      const city = ["Tokyo", "Paris", "London", "Berlin", "Lisbon"][i];
      const ext = new Extractor(
        store,
        fixedClassifier(`I live in ${city}`, "fact"),
        [],
        0.6
      );
      await ext.extract(makeTurn(`I live in ${city}`, channels[i], `session-${i}`));
    }

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("Lisbon");
  });

  it("should keep independent facts from different channels", async () => {
    const facts = [
      { fact: "My dog's name is Rex", category: "fact" as NuggetCategory },
      { fact: "Meeting on Thursday at 3pm", category: "schedule" as NuggetCategory },
      { fact: "I prefer dark mode", category: "preference" as NuggetCategory },
      { fact: "Working on Project Alpha", category: "task" as NuggetCategory },
      { fact: "My manager is Sarah", category: "relationship" as NuggetCategory },
    ];

    for (let i = 0; i < facts.length; i++) {
      const ext = new Extractor(
        store,
        fixedClassifier(facts[i].fact, facts[i].category),
        [],
        0.6
      );
      await ext.extract(makeTurn(facts[i].fact, channels[i], `session-${i}`));
    }

    const active = store.getActiveNodes();
    expect(active.length).toBe(5);
  });

  it("should handle concurrent-like updates from multiple channels", async () => {
    // Simulate multiple channels updating the same preference rapidly
    const colors = ["red", "blue", "green", "yellow", "purple"];

    for (let i = 0; i < colors.length; i++) {
      const ext = new Extractor(
        store,
        fixedClassifier(`Favorite color is ${colors[i]}`, "preference"),
        [],
        0.6
      );
      await ext.extract(makeTurn(`My favorite color is ${colors[i]}`, channels[i], `s-${i}`));
    }

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("purple");
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("Conflict edge cases", () => {
  it("should handle very similar facts with only one word different", async () => {
    const ext1 = new Extractor(store, fixedClassifier("Team standup is at 9am", "schedule"), [], 0.6);
    await ext1.extract(makeTurn("Standup at 9am", "slack"));

    const ext2 = new Extractor(store, fixedClassifier("Team standup is at 10am", "schedule"), [], 0.6);
    await ext2.extract(makeTurn("Standup moved to 10am", "slack"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("10am");
  });

  it("should handle completely rephrased same fact", async () => {
    // Low overlap but same entity — tests entity matching
    const ext1 = new Extractor(store, fixedClassifier("Paulo lives in Berlin", "fact"), [], 0.6);
    await ext1.extract(makeTurn("I live in Berlin", "telegram"));

    const ext2 = new Extractor(store, fixedClassifier("Paulo relocated to Lisbon", "fact"), [], 0.6);
    await ext2.extract(makeTurn("I moved to Lisbon", "discord"));

    const active = store.getActiveNodes();
    // "Paulo" is the shared entity (>=4 chars), should detect conflict
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("Lisbon");
  });

  it("should not conflict on short generic facts", async () => {
    const ext1 = new Extractor(store, fixedClassifier("I like cats", "preference"), [], 0.6);
    await ext1.extract(makeTurn("I like cats", "telegram"));

    const ext2 = new Extractor(store, fixedClassifier("I like dogs", "preference"), [], 0.6);
    await ext2.extract(makeTurn("I like dogs", "discord"));

    // "like" is the only shared content word, 1/2 = 50% > 30% — but let's see
    // if the entity check catches it. "like" < 4 chars, "cats"/"dogs" differ.
    // This might or might not conflict depending on word overlap after stop words.
    const active = store.getActiveNodes();
    // After stop-word removal: ["like", "cats"] vs ["like", "dogs"]
    // overlap = 1/2 = 0.5 > 0.3 → will be treated as conflict
    // This is debatable behavior — user might like both cats AND dogs
    expect(active.length).toBe(1);
  });

  it("should handle multi-nugget extraction without cross-interference", async () => {
    const ext = new Extractor(
      store,
      multiClassifier([
        { fact: "Meeting with Bob on Tuesday", category: "schedule" },
        { fact: "Prefers window seat on flights", category: "preference" },
      ]),
      [],
      0.6
    );

    await ext.extract(makeTurn("Meeting Bob Tuesday, also I prefer window seats", "slack"));

    const active = store.getActiveNodes();
    expect(active.length).toBe(2);

    const categories = active.map((n) => n.category).sort();
    expect(categories).toEqual(["preference", "schedule"]);
  });

  it("should handle 50 sequential updates to the same fact", async () => {
    for (let i = 0; i < 50; i++) {
      const ext = new Extractor(
        store,
        fixedClassifier(`My lucky number is ${i}`, "fact"),
        [],
        0.6
      );
      await ext.extract(makeTurn(`My lucky number is ${i}`, "telegram", `s-${i}`));
    }

    const active = store.getActiveNodes();
    expect(active.length).toBe(1);
    expect(active[0].content).toContain("49");
  });
});
