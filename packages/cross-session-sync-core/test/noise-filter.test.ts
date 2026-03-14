import { describe, it, expect } from "vitest";
import { NoiseFilter } from "../src/noise-filter.js";
import { DEFAULT_CONFIG } from "../src/types.js";

describe("NoiseFilter", () => {
  const filter = new NoiseFilter(DEFAULT_CONFIG.noiseFilterPatterns);

  it("rejects empty messages", () => {
    expect(filter.shouldProcess("")).toBe(false);
    expect(filter.shouldProcess("   ")).toBe(false);
  });

  it("rejects short messages (< 5 words)", () => {
    expect(filter.shouldProcess("ok sure")).toBe(false);
    expect(filter.shouldProcess("yes I will")).toBe(false);
    expect(filter.shouldProcess("hi")).toBe(false);
  });

  it("rejects emoji-only messages", () => {
    expect(filter.shouldProcess("👍")).toBe(false);
    expect(filter.shouldProcess("😂😂😂")).toBe(false);
    expect(filter.shouldProcess("🎉 🎊 ✨")).toBe(false);
  });

  it("rejects known noise patterns", () => {
    expect(filter.shouldProcess("lol")).toBe(false);
    expect(filter.shouldProcess("Thanks")).toBe(false);
    expect(filter.shouldProcess("sounds good")).toBe(false);
  });

  it("accepts meaningful messages", () => {
    expect(filter.shouldProcess("My meeting with Acme Corp is on Thursday")).toBe(true);
    expect(filter.shouldProcess("I prefer dark mode for all applications")).toBe(true);
    expect(filter.shouldProcess("The project deadline was moved to next Friday")).toBe(true);
  });

  it("accepts questions with enough substance", () => {
    expect(filter.shouldProcess("When is the next team standup meeting scheduled")).toBe(true);
  });
});
