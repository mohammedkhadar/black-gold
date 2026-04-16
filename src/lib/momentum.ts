import { createHash } from "node:crypto";
import type { NewsItem, MarketData, MomentumResult } from "./types.js";

export function computeNewsHash(items: NewsItem[]): string {
  const content = items.map((i) => i.title).sort().join("\n");
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

export function computeMomentum(market: MarketData | null, history: number[]): MomentumResult {
  if (!market) return { momentumScore: 0, rsi: null };

  // 1. Intraday (24h) change score — scaled ±5% → full ±40 pts
  const changePct = market.changePct ?? 0;
  const intradayScore = Math.max(-40, Math.min(40, (changePct / 5) * 40));

  // 2. Position within day range (0 = at low, 1 = at high) → ±20 pts
  let rangeScore = 0;
  const range = (market.dayHigh ?? 0) - (market.dayLow ?? 0);
  if (range > 0) {
    const pos = (market.price - market.dayLow) / range;
    rangeScore = (pos - 0.5) * 40; // ±20
  }

  // 3. RSI(14) → ±40 pts  (RSI 70 → +40, RSI 30 → -40, RSI 50 → 0)
  let rsi: number | null = null;
  let rsiScore = 0;
  if (history.length >= 2) {
    const closes = history.slice(-15);
    let gains = 0, losses = 0;
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const n = closes.length - 1;
    const avgGain = gains / n;
    const avgLoss = losses / n;
    rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    rsiScore = Math.max(-40, Math.min(40, (rsi - 50) * (40 / 20)));
  }

  return { momentumScore: Math.round(intradayScore + rangeScore + rsiScore), rsi };
}
