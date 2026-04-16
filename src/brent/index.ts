import "dotenv/config";
import { program } from "commander";

import { Trading212Client } from "../lib/t212.js";
import { cmdSearchInstruments } from "../lib/execution.js";
import { runSignal, runLoop } from "../lib/signal-runner.js";
import { DEFAULT_TICKER, MAX_ORDER_QTY, NEWS_API_QUERY, AI_BLEND, RSS_FEEDS, isRelevant } from "./config.js";
import { fetchMarketData, fetchPriceHistory } from "./market.js";
import type { MarketData } from "../lib/types.js";
import { PROCESS_TIMEOUT_MS, DEFAULT_INTERVAL_MINUTES } from "../lib/config.js";

setTimeout(() => {
  console.warn("[WARN] Process timeout reached (4 min) — forcing exit.");
  process.exit(0);
}, PROCESS_TIMEOUT_MS);

function buildPrompt(headlines: string, market: MarketData | null): string {
  const priceCtx = market
    ? `Current Brent crude price: $${market.price.toFixed(2)} (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(2)}% today).`
    : "Current Brent crude price: unavailable.";

  return `You are an expert oil market analyst.

Your task: analyse the headlines and price below, then output your answer.

OUTPUT RULES — CRITICAL:
- Your ENTIRE response must be one single JSON object.
- Do NOT include any text, explanation, thinking, or markdown before or after the JSON.
- Do NOT wrap in code fences.
- The JSON must have exactly these three keys: signal, netScore, reasoning.
- signal: exactly one of "BUY", "HOLD", or "SELL" (uppercase string).
- netScore: integer between -100 and 100.
- reasoning: one sentence string explaining the signal.

Example of the ONLY acceptable output format:
{"signal":"BUY","netScore":42,"reasoning":"Supply disruption risk outweighs demand concerns."}

${priceCtx}

Latest headlines:
${headlines}

Your JSON response:`;
}

async function runOnce(
  client: Trading212Client | null,
  ticker: string,
  orderQty: number,
  execute: boolean,
  autoConfirm: boolean
): Promise<Record<string, unknown>> {
  return runSignal(
    {
      name: "Brent Crude",
      ticker,
      priceContext: (market) => market ? `Current Brent crude price: $${market.price.toFixed(2)} (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(2)}% today).` : "Current Brent crude price: unavailable.",
      priceFormatter: (p) => p.toFixed(2),
      disclaimer: "",
      redisPrefix: "brent",
      buildPrompt,
      isRelevant,
      rssFeeds: RSS_FEEDS,
      newsApiQuery: NEWS_API_QUERY,
      aiBlend: AI_BLEND,
    },
    {
      openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
      groqApiKey: process.env.GROQ_API_KEY ?? "",
      newsApiKey: process.env.NEWS_API_KEY ?? "",
    },
    { client, ticker, orderQty, execute, autoConfirm },
    fetchMarketData,
    fetchPriceHistory
  );
}

program
  .name("brent_crude_signals")
  .description("Brent crude geopolitical signal analyzer + Trading 212 paper trading executor")
  .option("--ticker <ticker>",            `Trading 212 ticker (default: ${DEFAULT_TICKER})`, DEFAULT_TICKER)
  .option("--quantity <number>",          `Shares per BUY order, capped at ${MAX_ORDER_QTY} (default: 1)`, (v) => parseInt(v, 10), 1)
  .option("--execute",                    "Submit orders to Trading 212 (requires T212 keys)")
  .option("--auto-confirm",               "Skip confirmation prompts (for unattended operation)")
  .option("--loop",                       "Run continuously")
  .option("--interval <minutes>",         "Refresh interval when --loop (default: 30)", parseInt, DEFAULT_INTERVAL_MINUTES)
  .option("--search-instruments <query>", "Search tradeable instruments by name/ticker and exit")
  .option("--json",                       "Print result as JSON");

program.parse(process.argv);
const opts = program.opts<{
  ticker: string;
  quantity: number;
  execute?: boolean;
  autoConfirm?: boolean;
  loop?: boolean;
  interval: number;
  searchInstruments?: string;
  json?: boolean;
}>();

const T212_API_KEY    = process.env.T212_API_KEY;
const T212_API_SECRET = process.env.T212_SECRET_KEY;

(async () => {
  let client: Trading212Client | null = null;

  if (opts.execute || opts.searchInstruments) {
    if (!T212_API_KEY || !T212_API_SECRET) {
      console.error("ERROR: T212_API_KEY and T212_SECRET_KEY must be set in .env or as GitHub Secrets.");
      process.exit(1);
    }
    client = new Trading212Client(T212_API_KEY, T212_API_SECRET);
  }

  if (opts.searchInstruments) {
    await cmdSearchInstruments(client!, opts.searchInstruments);
    process.exit(0);
  }

  const orderQty = Math.min(Math.max(1, Math.round(opts.quantity ?? 1)), MAX_ORDER_QTY);

  if (opts.loop) {
    await runLoop(() => runOnce(client, opts.ticker, orderQty, !!opts.execute, !!opts.autoConfirm), opts.interval);
  } else {
    const result = await runOnce(client, opts.ticker, orderQty, !!opts.execute, !!opts.autoConfirm);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
})();
