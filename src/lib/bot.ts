import { computeMomentum, computeNewsHash } from "./momentum.js";
import { callAI } from "./ai.js";
import { printScoreBreakdown } from "./display.js";
import { buildRiskMessage } from "./telegram.js";
import type { MarketData, NewsItem, SignalResult, Signal, AIBlend, TelegramClient } from "./types.js";
import type { Trading212Client } from "./t212.js";

/**
 * Shared signal computation pipeline used by both bots.
 * The caller builds the asset-specific prompt; this function handles
 * calling the AI, blending with momentum, and logging the score breakdown.
 */
export async function computeBlendedSignal(
  items: NewsItem[],
  market: MarketData | null,
  history: number[],
  prompt: string,
  aiBlend: AIBlend,
  openrouterKey: string,
  groqKey: string
): Promise<SignalResult> {
  const newsHash = computeNewsHash(items);
  const { aiScore, reasoning, aiAvailable } = await callAI(prompt, openrouterKey, groqKey);
  const { momentumScore, rsi } = computeMomentum(market, history);
  const blendedScore = Math.round(aiScore * aiBlend.ai + momentumScore * aiBlend.momentum);
  const signal: Signal = !aiAvailable
    ? "HOLD"
    : blendedScore > 15 ? "BUY" : blendedScore < -15 ? "SELL" : "HOLD";

  printScoreBreakdown(reasoning, momentumScore, rsi, aiScore, blendedScore);

  return { signal, netScore: blendedScore, aiScore, momentumScore, rsi, newsHash, reasoning };
}

/**
 * Checks stop-loss and take-profit thresholds for an open position.
 * Sends the appropriate Telegram alert and returns true if a risk exit was triggered.
 */
export async function checkRiskManagement(
  client: Trading212Client,
  market: MarketData,
  ticker: string,
  stopLossPct: number,
  takeProfitPct: number,
  telegram: TelegramClient,
  formatPrice: (p: number) => string
): Promise<boolean> {
  try {
    const pos = await client.getPosition(ticker);
    if (!pos || parseFloat(pos.quantity) <= 0) return false;

    const entry = parseFloat(pos.averagePrice);
    const pct   = entry > 0 ? ((market.price - entry) / entry) * 100 : 0;

    if (pct <= -stopLossPct) {
      console.log(`[RISK] Stop-loss triggered: ${pct.toFixed(2)}% from entry $${formatPrice(entry)} — forcing SELL`);
      await telegram.send(buildRiskMessage("stop-loss", ticker, market, entry, pct, formatPrice));
      return true;
    }
    if (pct >= takeProfitPct) {
      console.log(`[RISK] Take-profit triggered: +${pct.toFixed(2)}% from entry $${formatPrice(entry)} — forcing SELL`);
      await telegram.send(buildRiskMessage("take-profit", ticker, market, entry, pct, formatPrice));
      return true;
    }
  } catch { /* no open position or fetch failed */ }
  return false;
}
