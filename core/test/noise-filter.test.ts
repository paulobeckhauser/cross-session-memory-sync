import { describe, it, expect } from "vitest";
import { NoiseFilter } from "../src/noise-filter.js";

const DEFAULT_PATTERNS = [
  "ok", "lol", "thanks", "thank you", "haha",
  "yeah", "yes", "no", "sure", "cool",
  "nice", "great", "awesome", "got it", "sounds good",
  "👍", "👎", "🙏", "😂", "😊",
];

describe("NoiseFilter", () => {
  const filter = new NoiseFilter(DEFAULT_PATTERNS);

  it("should reject empty messages", () => {
    expect(filter.shouldProcess("")).toBe(false);
    expect(filter.shouldProcess("   ")).toBe(false);
  });

  it("should reject short messages (< 5 words)", () => {
    expect(filter.shouldProcess("hi there")).toBe(false);
    expect(filter.shouldProcess("yes please")).toBe(false);
    expect(filter.shouldProcess("ok sure")).toBe(false);
  });

  it("should reject emoji-only messages", () => {
    expect(filter.shouldProcess("👍👍👍")).toBe(false);
    expect(filter.shouldProcess("😂 😊 🎉")).toBe(false);
  });

  it("should reject known noise patterns", () => {
    expect(filter.shouldProcess("ok")).toBe(false);
    expect(filter.shouldProcess("thanks")).toBe(false);
    expect(filter.shouldProcess("sounds good")).toBe(false);
    expect(filter.shouldProcess("Got it")).toBe(false); // case insensitive
  });

  it("should accept meaningful messages", () => {
    expect(
      filter.shouldProcess("I have a meeting on Thursday at 3pm")
    ).toBe(true);
    expect(
      filter.shouldProcess("Please change my preference to dark mode")
    ).toBe(true);
    expect(
      filter.shouldProcess("The project deadline is next Friday April 5th")
    ).toBe(true);
  });

  it("should accept longer messages even with noise words", () => {
    expect(
      filter.shouldProcess("Ok so my meeting is on Thursday afternoon")
    ).toBe(true);
  });
});
