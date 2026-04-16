import axios from "axios";
import type { MarketData, TelegramClient } from "./types.js";

/** Build the BUY/SELL Telegram signal alert message. */
export function buildSignalMessage(
  assetName: string,
  signal: string,
  market: MarketData | null,
  formatPrice: (p: number) => string,
  netScore: number,
  aiScore: number,
  momentumScore: number,
  reasoning: string
): string {
  const emoji = signal === "BUY" ? "🟢" : "🔴";
  const sign = (n: number) => (n >= 0 ? "+" : "") + n;
  const priceStr = market
    ? ` @ $${formatPrice(market.price)} (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(2)}%)`
    : "";
  return (
    `${emoji} <b>${assetName} ${signal}</b>${priceStr}\n` +
    `Score: ${sign(netScore)}  (AI ${sign(aiScore)} / Mom ${sign(momentumScore)})\n` +
    `${reasoning ? `Reasoning: ${reasoning}\n` : ""}` +
    `Time: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`
  );
}

/** Build the stop-loss / take-profit Telegram alert message. */
export function buildRiskMessage(
  kind: "stop-loss" | "take-profit",
  ticker: string,
  market: MarketData,
  entry: number,
  pct: number,
  formatPrice: (p: number) => string
): string {
  const emoji = kind === "stop-loss" ? "🛑" : "💰";
  const label = kind === "stop-loss" ? "Stop-loss triggered" : "Take-profit triggered";
  const sign = pct >= 0 ? "+" : "";
  return `${emoji} <b>${label}</b>\n<code>${ticker}</code>  Entry: $${formatPrice(entry)}  Now: $${formatPrice(market.price)}  (${sign}${pct.toFixed(2)}%)`;
}

export function createTelegramClient(botToken: string | undefined, chatId: string | undefined): TelegramClient {
  return {
    async send(text: string): Promise<void> {
      if (!botToken || !chatId) return;
      try {
        await axios.post(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          { chat_id: chatId, text, parse_mode: "HTML" },
          { timeout: 10000 }
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[WARN] Telegram notification failed: ${msg}`);
      }
    },
  };
}
