import "dotenv/config";
import { program } from "commander";

import { C, col } from "../lib/colors.js";
import { Trading212Client } from "../lib/t212.js";
import { fetchRssNews, fetchNewsApiNews, fetchTrumpPosts } from "../lib/news.js";
import { computeMomentum, computeNewsHash } from "../lib/momentum.js";
import { callAI } from "../lib/ai.js";
import { createRedisClient } from "../lib/redis.js";
import { createTelegramClient } from "../lib/telegram.js";
import { printAccountInfo, printPositionInfo, printSignal, printTopItems, printDisclaimer } from "../lib/display.js";
import { executeSignal, cmdSearchInstruments, runLoop } from "../lib/execution.js";
import { DEFAULT_TICKER, MAX_ORDER_QTY, STOP_LOSS_PCT, TAKE_PROFIT_PCT, NEWS_API_QUERY, AI_BLEND, RSS_FEEDS, isRelevant } from "./config.js";
import { fetchMarketData, fetchPriceHistory } from "./market.js";

// Hard process-exit guard — prevents CI jobs hanging indefinitely
setTimeout(() => {
  console.warn("[WARN] Process timeout reached (4 min) — forcing exit.");
  process.exit(0);
}, 4 * 60 * 1000);

// ---------------------------------------------------------------------------
// Env + singletons
// ---------------------------------------------------------------------------

const T212_API_KEY       = process.env.T212_API_KEY;
const T212_API_SECRET    = process.env.T212_SECRET_KEY;
const NEWS_API_KEY       = process.env.NEWS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;

const redis    = createRedisClient(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);
const telegram = createTelegramClient(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);

// ---------------------------------------------------------------------------
// Signal analysis
// ---------------------------------------------------------------------------

async function computeSignal(items, market, history) {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");

  const newsHash = computeNewsHash(items);
  const headlines = items.map((i) => `- ${i.title} [${i.source}]`).join("\n");
  const priceCtx = market
    ? `Current Brent crude price: $${market.price.toFixed(2)} (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(2)}% today).`
    : "Current Brent crude price: unavailable.";

  const prompt = `You are an expert oil market analyst.

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

  const { aiScore, reasoning, aiAvailable } = await callAI(prompt, OPENROUTER_API_KEY, GROQ_API_KEY);
  const { momentumScore, rsi } = computeMomentum(market, history);
  const blendedScore = Math.round(aiScore * AI_BLEND.ai + momentumScore * AI_BLEND.momentum);
  const signal = !aiAvailable ? "HOLD" : blendedScore > 15 ? "BUY" : blendedScore < -15 ? "SELL" : "HOLD";

  console.log(`  ${C.dim}Nemotron reasoning: ${reasoning}${C.reset}`);
  const rsiStr = rsi !== null ? `RSI ${rsi.toFixed(1)}` : "RSI n/a";
  console.log(`  ${C.dim}Momentum score: ${momentumScore >= 0 ? "+" : ""}${momentumScore}  (${rsiStr})  →  AI ${aiScore >= 0 ? "+" : ""}${aiScore}  →  Blended ${blendedScore >= 0 ? "+" : ""}${blendedScore}${C.reset}\n`);

  return { signal, netScore: blendedScore, aiScore, momentumScore, rsi, newsHash, reasoning };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

function printHeader(mode) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const modeStr = col(C.green, `[${mode}]`);
  console.log(`\n${C.bold}${"=".repeat(65)}${C.reset}`);
  console.log(`${C.bold}  Brent Crude Signal  →  Trading 212  ${modeStr}  ${C.dim}${now}${C.reset}`);
  console.log(`${C.bold}${"=".repeat(65)}${C.reset}\n`);
}

function printMarket(market) {
  if (!market) { console.log("  Market data unavailable.\n"); return; }
  const chgColor = market.changePct >= 0 ? C.green : C.red;
  const sign = market.changePct >= 0 ? "+" : "";
  console.log(`  ${C.bold}Brent Crude (${market.ticker})${C.reset}`);
  console.log(`  Price  : ${C.bold}${market.currency} ${market.price.toFixed(2)}${C.reset}  (${col(chgColor, `${sign}${market.changePct.toFixed(2)}%`)})`);
  console.log(`  Range  : ${market.dayLow?.toFixed(2)} – ${market.dayHigh?.toFixed(2)}`);
  console.log(`  Volume : ${market.volume.toLocaleString()}\n`);
}

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

async function runOnce(client, ticker, orderQty, execute, autoConfirm) {
  printHeader(client ? client.mode : "SIGNAL-ONLY");

  if (client) {
    await printAccountInfo(client);
    await printPositionInfo(client, ticker);
  }

  console.log("[INFO] Fetching market data …");
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
  console.log(`[INFO] Fetched ${before} articles, ${items.length} oil-relevant within last 5h …`);

  console.log("[INFO] Fetching price history for momentum …");
  const history = await fetchPriceHistory(14);

  let { signal, netScore, aiScore, momentumScore, rsi, newsHash, reasoning } = await computeSignal(items, market, history);

  printMarket(market);
  printSignal(signal, netScore);
  printTopItems(items);

  // Stop-loss / take-profit override
  let riskOverride = false;
  if (execute && client && market) {
    try {
      const riskPos = await client.getPosition(ticker);
      if (riskPos && parseFloat(riskPos.quantity) > 0) {
        const entry = parseFloat(riskPos.averagePrice);
        const pct   = entry > 0 ? ((market.price - entry) / entry) * 100 : 0;
        if (pct <= -STOP_LOSS_PCT) {
          console.log(`[RISK] Stop-loss triggered: ${pct.toFixed(2)}% from entry $${entry} — forcing SELL`);
          await telegram.send(`🛑 <b>Stop-loss triggered</b>\n<code>${ticker}</code>  Entry: $${entry.toFixed(2)}  Now: $${market.price.toFixed(2)}  (${pct.toFixed(2)}%)`);
          signal = "SELL"; riskOverride = true;
        } else if (pct >= TAKE_PROFIT_PCT) {
          console.log(`[RISK] Take-profit triggered: +${pct.toFixed(2)}% from entry $${entry} — forcing SELL`);
          await telegram.send(`💰 <b>Take-profit triggered</b>\n<code>${ticker}</code>  Entry: $${entry.toFixed(2)}  Now: $${market.price.toFixed(2)}  (+${pct.toFixed(2)}%)`);
          signal = "SELL"; riskOverride = true;
        }
      }
    } catch (_) { /* no open position or fetch failed */ }
  }

  // Telegram signal notification
  if (signal !== "HOLD" && !riskOverride) {
    const emoji = signal === "BUY" ? "🟢" : "🔴";
    const priceStr = market
      ? ` @ $${market.price.toFixed(2)} (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(2)}%)`
      : "";
    await telegram.send(
      `${emoji} <b>Brent Crude ${signal}</b>${priceStr}\n` +
      `Score: ${netScore >= 0 ? "+" : ""}${netScore}  (AI ${aiScore >= 0 ? "+" : ""}${aiScore} / Mom ${momentumScore >= 0 ? "+" : ""}${momentumScore})\n` +
      `${reasoning ? `Reasoning: ${reasoning}\n` : ""}` +
      `Time: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`
    );
  }

  // Order execution (skipped if news unchanged)
  let orderResult = null;
  if (execute && client) {
    const lastNewsHash = await redis.get("brent:lastNewsHash");
    if (lastNewsHash && lastNewsHash === newsHash) {
      console.log(`[INFO] News unchanged (hash: ${newsHash}) — skipping order.`);
    } else {
      if (lastNewsHash) console.log(`[INFO] News changed (${lastNewsHash} → ${newsHash}) — proceeding.`);
      orderResult = await executeSignal({ client, signal, ticker, orderQty, autoConfirm, maxOrderQty: MAX_ORDER_QTY, telegram });
    }
  }

  printDisclaimer();

  const output = {
    timestamp:  new Date().toISOString(),
    signal, netScore, aiScore, momentumScore,
    rsi:       rsi !== null ? parseFloat(rsi.toFixed(1)) : null,
    newsHash,
    price:     market?.price ?? null,
    changePct: market ? parseFloat(market.changePct.toFixed(2)) : null,
    order:     orderResult,
    relevantHeadlines: items.slice(0, 10).map(({ title, source }) => ({ title, source })),
  };

  await redis.set("brent:lastNewsHash", newsHash);
  await redis.append("brent:history", JSON.stringify({ ...output, reasoning }));

  return output;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

program
  .name("brent_crude_signals")
  .description("Brent crude geopolitical signal analyzer + Trading 212 paper trading executor")
  .option("--ticker <ticker>",            `Trading 212 ticker (default: ${DEFAULT_TICKER})`, DEFAULT_TICKER)
  .option("--quantity <number>",          `Shares per BUY order, capped at ${MAX_ORDER_QTY} (default: 1)`, (v) => parseInt(v, 10), 1)
  .option("--execute",                    "Submit orders to Trading 212 (requires T212 keys)")
  .option("--auto-confirm",               "Skip confirmation prompts (for unattended operation)")
  .option("--loop",                       "Run continuously")
  .option("--interval <minutes>",         "Refresh interval when --loop (default: 30)", parseInt, 30)
  .option("--search-instruments <query>", "Search tradeable instruments by name/ticker and exit")
  .option("--json",                       "Print result as JSON");

program.parse(process.argv);
const opts = program.opts();

(async () => {
  let client = null;

  if (opts.execute || opts.searchInstruments) {
    if (!T212_API_KEY || !T212_API_SECRET) {
      console.error("ERROR: T212_API_KEY and T212_SECRET_KEY must be set in .env or as GitHub Secrets.");
      process.exit(1);
    }
    client = new Trading212Client(T212_API_KEY, T212_API_SECRET);
  }

  if (opts.searchInstruments) {
    await cmdSearchInstruments(client, opts.searchInstruments);
    process.exit(0);
  }

  const orderQty = Math.min(Math.max(1, Math.round(opts.quantity ?? 1)), MAX_ORDER_QTY);

  if (opts.loop) {
    await runLoop(() => runOnce(client, opts.ticker, orderQty, !!opts.execute, !!opts.autoConfirm), opts.interval);
  } else {
    const result = await runOnce(client, opts.ticker, orderQty, !!opts.execute, !!opts.autoConfirm);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
  }
})();
