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

  const { aiScore, reasoning, aiAvailable } = await callAI(prompt, openrouterKey, groqKey);
  const { momentumScore, rsi } = computeMomentum(market, history);
  const blendedScore = Math.round(aiScore * aiBlend.ai + momentumScore * aiBlend.momentum);
  const signal: Signal = !aiAvailable ? "HOLD" : blendedScore > 15 ? "BUY" : blendedScore < -15 ? "SELL" : "HOLD";

  console.log(`  ${C.dim}Nemotron reasoning: ${reasoning}${C.reset}`);
  const rsiStr = rsi !== null ? `RSI ${rsi.toFixed(1)}` : "RSI n/a";
  console.log(`  ${C.dim}Momentum score: ${momentumScore >= 0 ? "+" : ""}${momentumScore}  (${rsiStr})  →  AI ${aiScore >= 0 ? "+" : ""}${aiScore}  →  Blended ${blendedScore >= 0 ? "+" : ""}${blendedScore}${C.reset}\n`);

  return { signal, netScore: blendedScore, aiScore, momentumScore, rsi, newsHash, reasoning };
}
