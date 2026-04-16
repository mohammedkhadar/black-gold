import { createHash } from "node:crypto";
import type { NewsItem, MarketData, MomentumResult } from "./types.js";

export function computeNewsHash(items: NewsItem[]): string {
  const content = items.map((i) => i.title).sort().join("\n");
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

function calculateATR(history: number[], period: number = 14): number | null {
  if (history.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const high = history[i] * 1.002;
    const low = history[i] * 0.998;
    const close = history[i - 1];
    const tr = Math.max(
      high - low,
      Math.abs(high - close),
      Math.abs(low - close)
    );
    trs.push(tr);
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateTrend(history: number[], periods: number): number {
  if (history.length < periods) return 0;
  const slice = history.slice(-periods);
  const first = slice[0];
  const last = slice[slice.length - 1];
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}

export function computeMomentum(
  market: MarketData | null,
  history: number[],
  fetchHistory?: (days: number) => Promise<number[]>
): MomentumResult {
  if (!market) return { momentumScore: 0, rsi: null, atr: null, trend7d: 0, trend30d: 0 };

  const changePct = market.changePct ?? 0;
  const intradayScore = Math.max(-40, Math.min(40, (changePct / 5) * 40));

  let rangeScore = 0;
  const range = (market.dayHigh ?? 0) - (market.dayLow ?? 0);
  if (range > 0) {
    const pos = (market.price - market.dayLow) / range;
    rangeScore = (pos - 0.5) * 40;
  }

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

  const atr = calculateATR(history, 14);
  const trend7d = calculateTrend(history, 7);
  const trend30d = calculateTrend(history, 30);

  const trend7dScore = Math.max(-20, Math.min(20, trend7d * 2));
  const trend30dScore = Math.max(-20, Math.min(20, trend30d));

  const momentumScore = Math.round(intradayScore + rangeScore + rsiScore + trend7dScore + trend30dScore);

  return { momentumScore, rsi, atr, trend7d, trend30d };
}
