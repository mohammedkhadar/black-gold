import { describe, it, expect } from "vitest";
import { isRelevant, DEFAULT_TICKER, AI_BLEND, RSS_FEEDS } from "../../src/brent/config.js";

describe("brent/config", () => {
  it("DEFAULT_TICKER is correct T212 ticker", () => {
    expect(DEFAULT_TICKER).toBe("EBRTm_EQ");
  });

  it("AI_BLEND sums to 1.0", () => {
    expect(AI_BLEND.ai + AI_BLEND.momentum).toBeCloseTo(1.0);
  });

  it("AI_BLEND is 50/50 for brent", () => {
    expect(AI_BLEND.ai).toBe(0.5);
    expect(AI_BLEND.momentum).toBe(0.5);
  });

  it("RSS_FEEDS is a non-empty array of strings", () => {
    expect(Array.isArray(RSS_FEEDS)).toBe(true);
    expect(RSS_FEEDS.length).toBeGreaterThan(0);
    RSS_FEEDS.forEach((f) => expect(typeof f).toBe("string"));
  });

  it("isRelevant returns true for oil-related title", () => {
    expect(isRelevant("Brent crude rises on OPEC cuts")).toBe(true);
    expect(isRelevant("Iran threatens to block Hormuz strait")).toBe(true);
    expect(isRelevant("Saudi Arabia increases oil production")).toBe(true);
  });

  it("isRelevant returns false for unrelated title", () => {
    expect(isRelevant("Local council approves new park")).toBe(false);
    expect(isRelevant("Bitcoin hits all-time high")).toBe(false);
  });

  it("isRelevant is case-insensitive", () => {
    expect(isRelevant("OPEC meets to discuss OIL production")).toBe(true);
    expect(isRelevant("BRENT crude dips below $80")).toBe(true);
  });
});
