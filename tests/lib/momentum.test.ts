import { describe, it, expect } from "vitest";
import { computeNewsHash, computeMomentum } from "../../src/lib/momentum.js";
import type { MarketData, NewsItem } from "../../src/lib/types.js";

const mockMarket = (overrides: Partial<MarketData> = {}): MarketData => ({
  ticker:    "BTC-USD",
  price:     50000,
  changePct: 2.5,
  dayHigh:   51000,
  dayLow:    49000,
  volume:    1000000,
  currency:  "USD",
  ...overrides,
});

describe("computeNewsHash", () => {
  it("returns a 12-char hex string", () => {
    const items: NewsItem[] = [
      { title: "BTC hits 50k", source: "CoinDesk", pubDate: null },
      { title: "Oil rises", source: "BBC", pubDate: null },
    ];
    const hash = computeNewsHash(items);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("same items (regardless of order) produce same hash", () => {
    const a: NewsItem[] = [
      { title: "BTC up", source: "A", pubDate: null },
      { title: "ETH down", source: "B", pubDate: null },
    ];
    const b: NewsItem[] = [
      { title: "ETH down", source: "B", pubDate: null },
      { title: "BTC up", source: "A", pubDate: null },
    ];
    expect(computeNewsHash(a)).toBe(computeNewsHash(b));
  });

  it("different items produce different hashes", () => {
    const a: NewsItem[] = [{ title: "Bitcoin rally", source: "X", pubDate: null }];
    const b: NewsItem[] = [{ title: "Bitcoin crash", source: "X", pubDate: null }];
    expect(computeNewsHash(a)).not.toBe(computeNewsHash(b));
  });

  it("returns consistent hash for empty list", () => {
    const hash = computeNewsHash([]);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("computeMomentum", () => {
  it("returns zero score and null RSI when market is null", () => {
    const result = computeMomentum(null, []);
    expect(result.momentumScore).toBe(0);
    expect(result.rsi).toBeNull();
  });

  it("returns numeric score for valid market data", () => {
    const result = computeMomentum(mockMarket(), []);
    expect(typeof result.momentumScore).toBe("number");
    expect(result.rsi).toBeNull(); // no history
  });

  it("positive changePct contributes positive intraday score", () => {
    const positive = computeMomentum(mockMarket({ changePct: 4, price: 50500, dayLow: 49000, dayHigh: 51000 }), []);
    const negative = computeMomentum(mockMarket({ changePct: -4, price: 49500, dayLow: 49000, dayHigh: 51000 }), []);
    expect(positive.momentumScore).toBeGreaterThan(negative.momentumScore);
  });

  it("computes RSI when sufficient history is provided", () => {
    // 15 prices with consistent gains to push RSI up
    const history = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114];
    const result = computeMomentum(mockMarket(), history);
    expect(result.rsi).not.toBeNull();
    expect(result.rsi).toBeGreaterThan(50); // consistent gains → RSI > 50
  });

  it("RSI 100 when all price moves are gains (no losses)", () => {
    const history = Array.from({ length: 15 }, (_, i) => 100 + i * 5); // strictly upward
    const result = computeMomentum(mockMarket(), history);
    expect(result.rsi).toBe(100);
  });

  it("RSI is between 0 and 100", () => {
    const history = [100, 99, 98, 97, 101, 96, 95, 94, 98, 93, 92, 91, 95, 90, 89];
    const result = computeMomentum(mockMarket(), history);
    if (result.rsi !== null) {
      expect(result.rsi).toBeGreaterThanOrEqual(0);
      expect(result.rsi).toBeLessThanOrEqual(100);
    }
  });

  it("caps momentum score within ±120 range", () => {
    // extreme positive
    const up = computeMomentum(
      mockMarket({ changePct: 100, price: 51000, dayLow: 49000, dayHigh: 51000 }),
      Array.from({ length: 15 }, (_, i) => 100 + i * 10)
    );
    expect(up.momentumScore).toBeLessThanOrEqual(120);

    // extreme negative
    const down = computeMomentum(
      mockMarket({ changePct: -100, price: 49000, dayLow: 49000, dayHigh: 51000 }),
      Array.from({ length: 15 }, (_, i) => 200 - i * 10)
    );
    expect(down.momentumScore).toBeGreaterThanOrEqual(-120);
  });
});
