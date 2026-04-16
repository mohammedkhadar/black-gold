import { C } from "./colors.js";
import { computeMomentum, computeNewsHash } from "./momentum.js";
import { callAI } from "./ai.js";
import type { AIBlend, MarketData, Signal, SignalResult } from "./types.js";

export async function computeSignal(
  items: Array<{ title: string; source: string; pubDate: Date | null }>,
  market: MarketData | null,
  history: number[],
  buildPrompt: (headlines: string, market: MarketData | null) => string,
  aiBlend: AIBlend,
  openrouterKey: string,
  groqKey: string,
): Promise<SignalResult> {
  const newsHash = computeNewsHash(items);
  const headlines = items.map((i) => `- ${i.title} [${i.source}]`).join("\n");
  const prompt = buildPrompt(headlines, market);

  const { aiScore, reasoning, aiAvailable, confidence } = await callAI(prompt, openrouterKey, groqKey);
  const { momentumScore, rsi, atr, trend7d, trend30d } = computeMomentum(market, history);

  const alignedMomentum = (aiScore > 0 && momentumScore > 0) || (aiScore < 0 && momentumScore < 0)
    ? momentumScore
    : momentumScore * 0.5;

  const blendedScore = Math.round(aiScore * aiBlend.ai + alignedMomentum * aiBlend.momentum);
  const signal: Signal = !aiAvailable ? "HOLD" : blendedScore > 50 ? "BUY" : blendedScore < -15 ? "SELL" : "HOLD";

  console.log(`  ${C.dim}Nemotron reasoning: ${reasoning}${C.reset}`);
  const rsiStr = rsi !== null ? `RSI ${rsi.toFixed(1)}` : "RSI n/a";
  const trendStr = `7d ${trend7d >= 0 ? "+" : ""}${trend7d.toFixed(1)}%  30d ${trend30d >= 0 ? "+" : ""}${trend30d.toFixed(1)}%`;
  console.log(`  ${C.dim}Momentum: ${momentumScore >= 0 ? "+" : ""}${momentumScore} (${rsiStr}) | ${trendStr}${C.reset}`);
  console.log(`  ${C.dim}AI ${aiScore >= 0 ? "+" : ""}${aiScore} → Blended ${blendedScore >= 0 ? "+" : ""}${blendedScore} | Confidence: ${confidence}%${C.reset}\n`);

  return { signal, netScore: blendedScore, aiScore, momentumScore, rsi, atr, trend7d, trend30d, newsHash, reasoning, confidence };
}
