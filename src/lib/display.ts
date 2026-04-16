import { C, col } from "./colors.js";
import type { Trading212Client } from "./t212.js";
import type { MarketData, NewsItem } from "./types.js";

export function printHeader(title: string, mode: string): void {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const modeStr = col(C.green, `[${mode}]`);
  console.log(`\n${C.bold}${"=".repeat(65)}${C.reset}`);
  console.log(`${C.bold}  ${title}  →  Trading 212  ${modeStr}  ${C.dim}${now}${C.reset}`);
  console.log(`${C.bold}${"=".repeat(65)}${C.reset}\n`);
}

export function printScoreBreakdown(
  reasoning: string,
  momentumScore: number,
  rsi: number | null,
  aiScore: number,
  blendedScore: number
): void {
  console.log(`  ${C.dim}Nemotron reasoning: ${reasoning}${C.reset}`);
  const rsiStr = rsi !== null ? `RSI ${rsi.toFixed(1)}` : "RSI n/a";
  const sign = (n: number) => (n >= 0 ? "+" : "") + n;
  console.log(`  ${C.dim}Momentum score: ${sign(momentumScore)}  (${rsiStr})  →  AI ${sign(aiScore)}  →  Blended ${sign(blendedScore)}${C.reset}\n`);
}

export async function printAccountInfo(client: Trading212Client): Promise<void> {
  try {
    const cash = await client.getCash();
    console.log(`  ${C.bold}Trading 212 Account (${client.mode})${C.reset}`);
    console.log(`  Free cash : ${cash.free}`);
    console.log(`  Invested  : ${cash.invested}`);
    console.log(`  Total     : ${cash.total}`);
    console.log(`  P&L       : ${cash.result}\n`);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 403) {
      console.warn("  [WARN] Account info requires 'Read account' permission.\n");
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [WARN] Could not fetch account info: ${msg}\n`);
    }
  }
}

export async function printPositionInfo(client: Trading212Client, ticker: string): Promise<void> {
  try {
    const pos = await client.getPosition(ticker);
    if (pos) {
      console.log(`  ${C.bold}Current position in ${ticker}${C.reset}`);
      console.log(`  Quantity       : ${pos.quantity}`);
      console.log(`  Avg price      : ${pos.averagePrice}`);
      console.log(`  Unrealised P&L : ${pos.ppl}\n`);
    } else {
      console.log(`  No open position in ${ticker}.\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [WARN] Could not fetch position for ${ticker}: ${msg}\n`);
  }
}

export function printSignal(signal: string, netScore: number): void {
  const sigColor = signal === "BUY" ? C.green : signal === "SELL" ? C.red : C.yellow;
  console.log(`  ${C.bold}Signal    : ${col(sigColor, signal)}${col(C.dim, " (via Nemotron-3-Super-120B)")}${C.reset}`);
  console.log(`  Net score : ${netScore >= 0 ? "+" : ""}${netScore}\n`);
}

export function printTopItems(items: NewsItem[], topN = 75): void {
  const top = items.slice(0, topN);
  if (!top.length) {
    console.log("  No headlines found.\n");
    return;
  }
  console.log(`  ${C.bold}Latest headlines:${C.reset}`);
  for (let i = 0; i < top.length; i++) {
    console.log(`  ${String(i + 1).padStart(2)}. ${top[i].title.slice(0, 80)}`);
    console.log(`       ${C.dim}${top[i].source}${C.reset}\n`);
  }
}

export function printDisclaimer(note = "Trading involves substantial risk of loss."): void {
  console.log(`\n${C.dim}${"─".repeat(65)}`);
  console.log("  Signals are informational. This is not financial advice.");
  console.log(`  ${note}${C.reset}`);
  console.log(`${C.dim}${"─".repeat(65)}${C.reset}\n`);
}

export function printMarketData(market: MarketData | null, label: string, formatPrice: (p: number) => string): void {
  if (!market) { console.log("  Market data unavailable.\n"); return; }
  const chgColor = market.changePct >= 0 ? C.green : C.red;
  const sign = market.changePct >= 0 ? "+" : "";
  console.log(`  ${C.bold}${label} (${market.ticker})${C.reset}`);
  console.log(`  Price  : ${C.bold}${market.currency} ${formatPrice(market.price)}${C.reset}  (${col(chgColor, `${sign}${market.changePct.toFixed(2)}%`)})`);
  console.log(`  Range  : ${formatPrice(market.dayLow ?? 0)} – ${formatPrice(market.dayHigh ?? 0)}`);
  console.log(`  Volume : ${market.volume.toLocaleString()}\n`);
}
