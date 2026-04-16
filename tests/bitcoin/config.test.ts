import { describe, it, expect } from "vitest";
import { isRelevant, DEFAULT_TICKER, AI_BLEND, RSS_FEEDS } from "../../src/bitcoin/config.js";

describe("bitcoin/config", () => {
  it("DEFAULT_TICKER is correct T212 ticker", () => {
    expect(DEFAULT_TICKER).toBe("IB1Tl_EQ");
  });

  it("AI_BLEND sums to 1.0", () => {
    expect(AI_BLEND.ai + AI_BLEND.momentum).toBeCloseTo(1.0);
  });

  it("AI_BLEND is 80/20 for bitcoin", () => {
    expect(AI_BLEND.ai).toBe(0.8);
    expect(AI_BLEND.momentum).toBe(0.2);
  });

  it("RSS_FEEDS is a non-empty array of strings", () => {
    expect(Array.isArray(RSS_FEEDS)).toBe(true);
    expect(RSS_FEEDS.length).toBeGreaterThan(0);
    RSS_FEEDS.forEach((f) => expect(typeof f).toBe("string"));
  });

  it("isRelevant returns true for BTC-related title", () => {
    expect(isRelevant("Bitcoin hits all-time high")).toBe(true);
    expect(isRelevant("SEC approves BTC spot ETF")).toBe(true);
    expect(isRelevant("Ethereum merge impact on crypto")).toBe(true);
  });

  it("isRelevant returns false for unrelated title", () => {
    expect(isRelevant("Local council approves new park")).toBe(false);
    expect(isRelevant("Premier League results from the weekend")).toBe(false);
  });

  it("isRelevant is case-insensitive", () => {
    expect(isRelevant("BITCOIN surges")).toBe(true);
    expect(isRelevant("BiTcOiN crash")).toBe(true);
  });
});
