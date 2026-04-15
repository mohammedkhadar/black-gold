/**
 * Brent Crude Geopolitical Trading Signal Analyzer + Trading 212 Executor
 * -------------------------------------------------------------------------
 * 1. Pulls geopolitical headlines from RSS feeds (+ NewsAPI if key supplied).
 * 2. Uses Groq AI to generate a BUY / HOLD / SELL signal for Brent crude.
 * 3. Optionally submits market orders via the Trading 212 Paper Trading API.
 *
 * SETUP
 *   Fill in .env with T212_API_KEY, T212_SECRET_KEY, NEWS_API_KEY (optional)
 *   npm install
 *   node brent_crude_signals.js
 */

import "dotenv/config";
import axios from "axios";
import RssParser from "rss-parser";
import yahooFinance from "yahoo-finance2";
import { createHash } from "node:crypto";

// yahoo-finance2 v2 exports the class as default; create one instance.
// Falls back to Stooq CSV if Yahoo rate-limits (429).
let _yfInstance = null;
try { _yfInstance = new yahooFinance.default(); } catch (_) { /* will use fallback */ }
import { program } from "commander";
import { Buffer } from "node:buffer";
import readline from "node:readline";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const T212_API_KEY      = process.env.T212_API_KEY;
const T212_API_SECRET   = process.env.T212_SECRET_KEY;
const NEWS_API_KEY      = process.env.NEWS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const T212_BASE       = "https://demo.trading212.com/api/v0";

const DEFAULT_TICKER = "EBRTm_EQ"; // WisdomTree Brent Crude Oil - EUR Daily Hedged (T212 paper)
const MAX_ORDER_QTY  = 1000;      // hard cap on quantity per order

const RSS_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://rss.dw.com/rdf/rss-en-world",
  "https://www.aljazeera.com/xml/rss/all.xml",
];

// ---------------------------------------------------------------------------
// ANSI colours
// ---------------------------------------------------------------------------

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[91m",
  green:  "\x1b[92m",
  yellow: "\x1b[93m",
};
const col = (c, s) => `${c}${s}${C.reset}`;

// ---------------------------------------------------------------------------
// Trading 212 API client
// ---------------------------------------------------------------------------

class Trading212Client {
  constructor(apiKey, apiSecret) {
    if (!apiKey || !apiSecret) {
      throw new Error("T212_API_KEY and T212_SECRET_KEY must be set in .env (local) or as GitHub Secrets (CI).");
    }
    this.base = T212_BASE;
    this.mode = "PAPER";
    const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
    this.headers = {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    };
  }

  async getCash() {
    return this._get("/equity/account/cash");
  }

  async getPosition(ticker) {
    try {
      return await this._get(`/equity/portfolio/${ticker}`);
    } catch (err) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  async placeMarketOrder(ticker, quantity) {
    return this._post("/equity/orders/market", { ticker, quantity });
  }

  async searchInstruments(query) {
    const all = await this._get("/equity/metadata/instruments");
    const q = query.toLowerCase();
    return all.filter(
      (i) => i.name?.toLowerCase().includes(q) || i.ticker?.toLowerCase().includes(q)
    );
  }

  async _get(path) {
    const res = await axios.get(this.base + path, { headers: this.headers, timeout: 15000 });
    return res.data;
  }

  async _post(path, body) {
    const res = await axios.post(this.base + path, body, { headers: this.headers, timeout: 15000 });
    return res.data;
  }
}

// ---------------------------------------------------------------------------
// News fetching
// ---------------------------------------------------------------------------

async function fetchRssNews(maxPerFeed = 10) {
  const parser = new RssParser();
  const items = [];
  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      const source = feed.title || url;
      for (const entry of feed.items.slice(0, maxPerFeed)) {
        items.push({
          title:  entry.title || "",
          source,
        });
      }
    } catch (err) {
      console.warn(`[WARN] RSS feed error (${url}): ${err.message}`);
    }
  }
  return items;
}

async function fetchNewsApiNews(query = "oil brent crude geopolitical") {
  if (!NEWS_API_KEY) return [];
  try {
    const res = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: query, language: "en", sortBy: "publishedAt", pageSize: 30, apiKey: NEWS_API_KEY },
      timeout: 10000,
    });
    return res.data.articles.map((a) => ({
      title:  a.title || "",
      source: a.source?.name || "NewsAPI",
    }));
  } catch (err) {
    console.warn(`[WARN] NewsAPI error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

async function fetchMarketData() {
  // Try Stooq CSV first (no auth, no rate limits) — CB.F = Brent, CL.F = WTI
  const stooqSymbols = ["cb.f", "cl.f"];
  for (const sym of stooqSymbols) {
    try {
      const res = await axios.get(
        `https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`,        { timeout: 10000 }
      );
      const lines = res.data.trim().split("\n");
      if (lines.length < 2) continue;
      const cols = lines[1].split(",");
      // cols: Symbol,Date,Time,Open,High,Low,Close,Volume
      const price = parseFloat(cols[6]);
      const open  = parseFloat(cols[3]);
      if (!price || price === 0) continue;
      return {
        ticker:    decodeURIComponent(sym),
        price,
        prevClose: open,   // Stooq doesn't give prev-close; use open as proxy
        dayHigh:   parseFloat(cols[4]),
        dayLow:    parseFloat(cols[5]),
        volume:    parseInt(cols[7]) || 0,
        currency:  "USD",
        changePct: open ? ((price - open) / open) * 100 : 0,
      };
    } catch (err) {
      console.warn(`[WARN] Stooq unavailable for ${sym}: ${err.message}`);
    }
  }

  // Fallback: yahoo-finance2
  if (_yfInstance) {
    for (const ticker of ["BZ=F", "CL=F"]) {
      try {
        const quote = await Promise.race([
          _yfInstance.quote(ticker, undefined, { validateResult: false }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
        ]);
        if (!quote?.regularMarketPrice) continue;
        return {
          ticker,
          price:     quote.regularMarketPrice,
          prevClose: quote.regularMarketPreviousClose,
          dayHigh:   quote.regularMarketDayHigh,
          dayLow:    quote.regularMarketDayLow,
          volume:    quote.regularMarketVolume || 0,
          currency:  quote.currency || "USD",
          changePct: quote.regularMarketChangePercent || 0,
        };
      } catch (err) {
        console.warn(`[WARN] Yahoo Finance unavailable for ${ticker}: ${err.message}`);
      }
    }
  }

  console.warn("[WARN] All market data sources unavailable — continuing without price.");
  return null;
}

// ---------------------------------------------------------------------------
// Signal analysis
// ---------------------------------------------------------------------------

function computeNewsHash(items) {
  const content = items
    .map((i) => i.title)
    .sort()
    .join("\n");
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

// Nemotron signal analysis via OpenRouter
async function computeSignal(items, market) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set in .env or GitHub Secrets.");
  }

  const newsHash = computeNewsHash(items);

  const headlines = items
    .slice(0, 25)
    .map((i) => `- ${i.title} [${i.source}]`)
    .join("\n");

  const priceContext = market
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

${priceContext}

Latest headlines:
${headlines}

Your JSON response:`;

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  const msg = res.data.choices[0]?.message;
  const content = msg?.content?.trim() ?? "";

  // Try strict JSON parse first, then extract JSON block, then parse prose
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      // Extract signal from prose as last resort
      const sigMatch = content.match(/\b(BUY|SELL|HOLD)\b/i);
      if (!sigMatch) throw new Error(`No JSON in response: ${content.slice(0, 120)}`);
      const scoreMatch = content.match(/[-+]?\d+/);
      parsed = {
        signal: sigMatch[1].toUpperCase(),
        netScore: scoreMatch ? parseInt(scoreMatch[0], 10) : 0,
        reasoning: content.slice(0, 120).replace(/\n/g, " "),
      };
    }
  }
  const signal = ["BUY", "HOLD", "SELL"].includes(parsed.signal) ? parsed.signal : "HOLD";
  const netScore = typeof parsed.netScore === "number" ? parsed.netScore : 0;

  console.log(`  ${C.dim}Nemotron reasoning: ${parsed.reasoning}${C.reset}\n`);
  return { signal, netScore, newsHash };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function printHeader(mode) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const modeStr = col(C.green, `[${mode}]`);
  console.log(`\n${C.bold}${"=".repeat(65)}${C.reset}`);
  console.log(`${C.bold}  Brent Crude Signal  →  Trading 212  ${modeStr}  ${C.dim}${now}${C.reset}`);
  console.log(`${C.bold}${"=".repeat(65)}${C.reset}\n`);
}

async function printAccount(client) {
  try {
    const cash = await client.getCash();
    console.log(`  ${C.bold}Trading 212 Account (${client.mode})${C.reset}`);
    console.log(`  Free cash : ${cash.free}`);
    console.log(`  Invested  : ${cash.invested}`);
    console.log(`  Total     : ${cash.total}`);
    console.log(`  P&L       : ${cash.result}\n`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) {
      console.warn(`  [WARN] Account info requires 'Read account' permission — enable in T212 API settings.\n`);
    } else {
      console.warn(`  [WARN] Could not fetch account info: ${err.message}\n`);
    }
  }
}

async function printPosition(client, ticker) {
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
  } catch (err) {
    console.warn(`  [WARN] Could not fetch position for ${ticker}: ${err.message}\n`);
  }
}

function printMarket(market) {
  if (!market) {
    console.log("  Market data unavailable.\n");
    return;
  }
  const chgColor = market.changePct >= 0 ? C.green : C.red;
  const sign     = market.changePct >= 0 ? "+" : "";
  console.log(`  ${C.bold}Brent Crude (${market.ticker})${C.reset}`);
  console.log(`  Price  : ${C.bold}${market.currency} ${market.price.toFixed(2)}${C.reset}  (${col(chgColor, `${sign}${market.changePct.toFixed(2)}%`)})`);
  console.log(`  Range  : ${market.dayLow?.toFixed(2)} – ${market.dayHigh?.toFixed(2)}`);
  console.log(`  Volume : ${market.volume.toLocaleString()}\n`);
}

function printSignal(signal, netScore) {
  const sigColor = signal === "BUY" ? C.green : signal === "SELL" ? C.red : C.yellow;
  console.log(`  ${C.bold}Signal    : ${col(sigColor, signal)}${col(C.dim, " (via Nemotron-3-Super-120B)")}${C.reset}`);
  console.log(`  Net score : ${netScore >= 0 ? "+" : ""}${netScore}\n`);
}

function printTopItems(items, topN = 10) {
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

function printDisclaimer() {
  console.log(`\n${C.dim}${"─".repeat(65)}`);
  console.log("  Signals are informational. This is not financial advice.");
  console.log(`  Trading involves substantial risk of loss.${C.reset}`);
  console.log(`${C.dim}${"─".repeat(65)}${C.reset}\n`);
}

// ---------------------------------------------------------------------------
// Order execution
// ---------------------------------------------------------------------------

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
}

async function executeSignal(client, signal, ticker, orderQty, autoConfirm = false) {
  if (signal === "HOLD") {
    console.log("[INFO] Signal is HOLD — no order placed.");
    return null;
  }

  orderQty = Math.min(Math.max(1, Math.round(orderQty)), MAX_ORDER_QTY);

  let position = null;
  try {
    position = await client.getPosition(ticker);
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) {
      console.error(`[ERROR] Authentication failed on ${client.mode} endpoint (401). Your key may be for the wrong environment.`);
    } else {
      console.error(`[ERROR] Failed to fetch position: ${err.message}`);
    }
    return null;
  }

  if (signal === "SELL") {
    if (!position || parseFloat(position.quantity) <= 0) {
      console.log(`[INFO] SELL signal but no open position in ${ticker} — skipping.`);
      return null;
    }
  }

  const actionColor = signal === "BUY" ? C.green : C.red;
  const sellQty = signal === "SELL" ? Math.abs(parseFloat(position.quantity)) : orderQty;
  console.log(`\n  ${C.bold}Proposed order${C.reset}`);
  console.log(`  Action  : ${col(actionColor, signal)}`);
  console.log(`  Ticker  : ${ticker}  (${client.mode})`);
  console.log(`  Quantity: ${sellQty} share(s)`);

  if (!autoConfirm) {
    const answer = await askQuestion(`\n  Confirm ${signal} order? [y/N]: `);
    if (answer.trim().toLowerCase() !== "y") {
      console.log("  Order cancelled by user.");
      return null;
    }
  }

  try {
    const qty = signal === "BUY" ? orderQty : -sellQty;
    const order = await client.placeMarketOrder(ticker, qty);
    const sigColor = signal === "BUY" ? C.green : C.red;
    console.log(`\n  ${col(sigColor, "Order submitted")}  id=${order.id ?? "?"}`);
    console.log(`[INFO] Order response: ${JSON.stringify(order, null, 2)}`);
    return order;
  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[ERROR] Order failed [${err.response?.status}]: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Instrument search
// ---------------------------------------------------------------------------

async function cmdSearchInstruments(client, query) {
  console.log(`\nSearching instruments for '${query}' …\n`);
  try {
    const results = await client.searchInstruments(query);
    if (!results.length) {
      console.log("  No matching instruments found.");
      return;
    }
    for (const inst of results.slice(0, 20)) {
      console.log(`  ${(inst.ticker || "?").padEnd(20)}  ${inst.name || "?"}`);
    }
    console.log();
  } catch (err) {
    console.error(`[ERROR] Could not fetch instruments: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

async function runOnce(client, ticker, orderQty, execute, autoConfirm) {
  printHeader(client ? client.mode : "SIGNAL-ONLY");

  if (client) {
    await printAccount(client);
    await printPosition(client, ticker);
  }

  console.log("[INFO] Fetching market data …");
  const market = await fetchMarketData();

  console.log("[INFO] Fetching RSS news …");
  let items = await fetchRssNews();

  console.log("[INFO] Fetching NewsAPI headlines …");
  items = items.concat(await fetchNewsApiNews());

  console.log(`[INFO] Fetched ${items.length} articles …`);

  const { signal, netScore, newsHash } = await computeSignal(items, market);

  printMarket(market);
  printSignal(signal, netScore);
  printTopItems(items);

  let orderResult = null;
  if (execute && client) {
    // Skip order if news hasn't changed since last order
    let lastNewsHash = null;
    try {
      const { readFile } = await import("node:fs/promises");
      const last = JSON.parse(await readFile("last_signal.json", "utf8"));
      if (last.order) lastNewsHash = last.newsHash ?? null;
    } catch (_) { /* no last_signal.json yet */ }

    if (lastNewsHash && lastNewsHash === newsHash) {
      console.log(`[INFO] News unchanged (hash: ${newsHash}) — skipping order.`);
    } else {
      if (lastNewsHash) console.log(`[INFO] News changed (${lastNewsHash} → ${newsHash}) — proceeding.`);
      orderResult = await executeSignal(client, signal, ticker, orderQty, autoConfirm);
    }
  }

  printDisclaimer();

  const output = {
    timestamp:  new Date().toISOString(),
    signal,
    netScore,
    newsHash,
    price:      market?.price ?? null,
    changePct:  market ? parseFloat(market.changePct.toFixed(2)) : null,
    order:      orderResult,
    relevantHeadlines: items
      .slice(0, 10)
      .map(({ title, source }) => ({ title, source })),
  };

  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile("last_signal.json", JSON.stringify(output, null, 2));
  } catch (err) {
    console.warn(`[WARN] Could not write last_signal.json: ${err.message}`);
  }

  return output;
}

async function runLoop(client, ticker, orderQty, execute, autoConfirm, intervalMinutes) {
  console.log(`Monitoring loop active — interval: ${intervalMinutes} min.  Ctrl+C to stop.\n`);
  while (true) {
    await runOnce(client, ticker, orderQty, execute, autoConfirm);
    console.log(`[INFO] Next refresh in ${intervalMinutes} minutes …`);
    await new Promise((r) => setTimeout(r, intervalMinutes * 60 * 1000));
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

program
  .name("brent_crude_signals")
  .description("Brent crude geopolitical signal analyzer + Trading 212 paper trading executor")
  .option("--ticker <ticker>",            `Trading 212 instrument ticker (default: ${DEFAULT_TICKER})`, DEFAULT_TICKER)
  .option("--quantity <number>",          `Number of shares per BUY order, capped at ${MAX_ORDER_QTY} (default: 1)`, (v) => parseInt(v, 10), 1)
  .option("--execute",                    "Submit orders to Trading 212 (requires T212_API_KEY + T212_SECRET_KEY)")
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
      console.error("ERROR: T212_API_KEY and T212_SECRET_KEY must be set in .env (local) or as GitHub Secrets (CI).");
      process.exit(1);
    }
    client = new Trading212Client(T212_API_KEY, T212_API_SECRET);
  }

  if (opts.searchInstruments) {
    if (!client) client = new Trading212Client(T212_API_KEY, T212_API_SECRET);
    await cmdSearchInstruments(client, opts.searchInstruments);
    process.exit(0);
  }

  const orderQty = Math.min(Math.max(1, Math.round(opts.quantity ?? 1)), MAX_ORDER_QTY);

  if (opts.loop) {
    await runLoop(client, opts.ticker, orderQty, !!opts.execute, !!opts.autoConfirm, opts.interval);
  } else {
    const result = await runOnce(client, opts.ticker, orderQty, !!opts.execute, !!opts.autoConfirm);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    }
  }
})();
