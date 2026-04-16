import "dotenv/config";
import { program } from "commander";

import { Trading212Client } from "../lib/t212.js";
import { fetchRssNews, fetchNewsApiNews, fetchTrumpPosts } from "../lib/news.js";
import { createRedisClient } from "../lib/redis.js";
import { createTelegramClient, buildSignalMessage } from "../lib/telegram.js";
import { printHeader, printAccountInfo, printPositionInfo, printSignal, printTopItems, printDisclaimer, printMarketData } from "../lib/display.js";
import { executeSignal, cmdSearchInstruments, runLoop } from "../lib/execution.js";
import { computeBlendedSignal, checkRiskManagement } from "../lib/bot.js";
import { DEFAULT_TICKER, MAX_ORDER_QTY, STOP_LOSS_PCT, TAKE_PROFIT_PCT, NEWS_API_QUERY, AI_BLEND, RSS_FEEDS, isRelevant } from "./config.js";
import { fetchMarketData, fetchPriceHistory } from "./market.js";
import type { MarketData, Signal } from "../lib/types.js";

// Hard process-exit guard
setTimeout(() => {
  console.warn("[WARN] Process timeout reached (4 min) — forcing exit.");
  process.exit(0);
}, 4 * 60 * 1000);

const T212_API_KEY       = process.env.T212_API_KEY;
const T212_API_SECRET    = process.env.T212_SECRET_KEY;
const NEWS_API_KEY       = process.env.NEWS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const GROQ_API_KEY       = process.env.GROQ_API_KEY       ?? "";

const redis    = createRedisClient(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);
const telegram = createTelegramClient(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);

const formatPrice = (p: number) =>
  p.toLocaleString("en-US", { maximumFractionDigits: 0 });

function buildPrompt(market: MarketData | null, headlines: string): string {
  const priceCtx = market
    ? `Current Bitcoin price: $${formatPrice(market.price)} (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(2)}% in last 24h).`
    : "Current Bitcoin price: unavailable.";
  return `You are an expert cryptocurrency market analyst specialising in Bitcoin.

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
{"signal":"BUY","netScore":55,"reasoning":"ETF inflows accelerating amid dovish Fed expectations."}

${priceCtx}

Latest headlines:
${headlines}

Your JSON response:`;
}

export async function runOnce(
  client: Trading212Client | null,
  ticker: string,
  orderQty: number,
  execute: boolean,
  autoConfirm: boolean
): Promise<Record<string, unknown>> {
  printHeader("Bitcoin Signal", client ? client.mode : "SIGNAL-ONLY");

  if (client) {
    await printAccountInfo(client);
    await printPositionInfo(client, ticker);
  }

  console.log("[INFO] Fetching BTC market data …");
  const market = await fetchMarketData();

  console.log("[INFO] Fetching RSS news …");
  let items = await fetchRssNews(RSS_FEEDS);

  console.log("[INFO] Fetching NewsAPI headlines …");
  items = items.concat(await fetchNewsApiNews(NEWS_API_QUERY, NEWS_API_KEY));

  console.log("[INFO] Fetching Trump posts …");
  items = items.concat(await fetchTrumpPosts());

  const before = items.length;
  const cutoff = new Date(Date.now() - 5 * 60 * 60 * 1000);
  items = items.filter((i) => isRelevant(i.title) && (!i.pubDate || i.pubDate >= cutoff));
  console.log(`[INFO] Fetched ${before} articles, ${items.length} BTC-relevant within last 5h …`);

  console.log("[INFO] Fetching BTC price history for momentum …");
  const history = await fetchPriceHistory(14);

  const headlines = items.map((i) => `- ${i.title} [${i.source}]`).join("\n");
  let { signal, netScore, aiScore, momentumScore, rsi, newsHash, reasoning } =
    await computeBlendedSignal(items, market, history, buildPrompt(market, headlines), AI_BLEND, OPENROUTER_API_KEY, GROQ_API_KEY);

  printMarketData(market, "Bitcoin", formatPrice);
  printSignal(signal, netScore);
  printTopItems(items);

  let riskOverride = false;
  if (execute && client && market) {
    riskOverride = await checkRiskManagement(client, market, ticker, STOP_LOSS_PCT, TAKE_PROFIT_PCT, telegram, formatPrice);
    if (riskOverride) signal = "SELL" as Signal;
  }

  if (signal !== "HOLD" && !riskOverride) {
    await telegram.send(buildSignalMessage("Bitcoin", signal, market, formatPrice, netScore, aiScore, momentumScore, reasoning));
  }

  let orderResult = null;
  if (execute && client) {
    const lastNewsHash = await redis.get("btc:lastNewsHash");
    if (lastNewsHash && lastNewsHash === newsHash) {
      console.log(`[INFO] News unchanged (hash: ${newsHash}) — skipping order.`);
    } else {
      if (lastNewsHash) console.log(`[INFO] News changed (${lastNewsHash} → ${newsHash}) — proceeding.`);
      orderResult = await executeSignal({ client, signal, ticker, orderQty, autoConfirm, maxOrderQty: MAX_ORDER_QTY, telegram });
    }
  }

  printDisclaimer("Cryptocurrency trading involves substantial risk of loss.");

  const output: Record<string, unknown> = {
    timestamp:  new Date().toISOString(),
    signal, netScore, aiScore, momentumScore,
    rsi:       rsi !== null ? parseFloat(rsi.toFixed(1)) : null,
    newsHash,
    price:     market?.price ?? null,
    changePct: market ? parseFloat(market.changePct.toFixed(2)) : null,
    order:     orderResult,
    relevantHeadlines: items.slice(0, 10).map(({ title, source }) => ({ title, source })),
  };

  await redis.set("btc:lastNewsHash", newsHash);
  await redis.append("btc:history", JSON.stringify({ ...output, reasoning }));

  return output;
}

// CLI
program
  .name("bitcoin_signals")
  .description("Bitcoin signal analyzer + Trading 212 paper trading executor")
  .option("--ticker <ticker>",            `Trading 212 ticker (default: ${DEFAULT_TICKER})`, DEFAULT_TICKER)
  .option("--quantity <number>",          `Shares per BUY order, capped at ${MAX_ORDER_QTY} (default: 1)`, (v) => parseInt(v, 10), 1)
  .option("--execute",                    "Submit orders to Trading 212 (requires T212 keys)")
  .option("--auto-confirm",               "Skip confirmation prompts (for unattended operation)")
  .option("--loop",                       "Run continuously")
  .option("--interval <minutes>",         "Refresh interval when --loop (default: 30)", parseInt, 30)
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
