/**
 * Bitcoin Trading Signal Analyzer + Trading 212 Executor
 * -------------------------------------------------------
 * 1. Pulls Bitcoin / crypto headlines from RSS feeds (+ NewsAPI if key supplied).
 * 2. Uses Nemotron AI (via OpenRouter) to generate a BUY / HOLD / SELL signal.
 * 3. Blends AI signal 50/50 with momentum (RSI-14 + intraday + range).
 * 4. Optionally submits market orders via the Trading 212 Paper Trading API.
 *
 * SETUP
 *   Fill in .env with T212_API_KEY, T212_SECRET_KEY, OPENROUTER_API_KEY
 *   npm install
 *   node bitcoin_signals.js
 */

import "dotenv/config";
import axios from "axios";
import RssParser from "rss-parser";
import { createHash } from "node:crypto";
import { program } from "commander";
import { Buffer } from "node:buffer";
import readline from "node:readline";

// Hard process-exit guard — prevents CI jobs hanging indefinitely
setTimeout(() => {
  console.warn("[WARN] Process timeout reached (4 min) — forcing exit.");
  process.exit(0);
}, 4 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const T212_API_KEY       = process.env.T212_API_KEY;
const T212_API_SECRET    = process.env.T212_SECRET_KEY;
const NEWS_API_KEY       = process.env.NEWS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const T212_BASE = "https://demo.trading212.com/api/v0";

// iShares Bitcoin ETP (Acc) — BlackRock, GBP, LSE, Schedule 70
const DEFAULT_TICKER = "IB1Tl_EQ";
const MAX_ORDER_QTY  = 1000;

const RSS_FEEDS = [
  // Dedicated crypto news
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://bitcoinmagazine.com/feed",
  // Google News RSS — aggregates Reuters/AP/FT/Bloomberg coverage of BTC
  "https://news.google.com/rss/search?q=bitcoin+crypto&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=bitcoin+regulation+ETF+SEC&hl=en-US&gl=US&ceid=US:en",
  // Macro / global news that moves crypto
  "https://feeds.bbci.co.uk/news/world/rss.xml",
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
      throw new Error("T212_API_KEY and T212_SECRET_KEY must be set in .env or as GitHub Secrets.");
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
// News relevance filter
// ---------------------------------------------------------------------------

const BTC_RELEVANCE_TERMS = [
  // Core crypto
  "bitcoin", "btc", "crypto", "cryptocurrency", "blockchain", "satoshi",
  "halving", "mining", "miner", "hash rate", "lightning network",
  // Key assets / tokens
  "ethereum", "eth", "altcoin", "stablecoin", "usdt", "usdc", "tether",
  "binance", "coinbase", "kraken", "bybit", "okx",
  // Regulation & macro
  "sec", "regulation", "regulatory", "etf", "spot etf", "futures",
  "blackrock", "fidelity", "grayscale", "gbtc", "ibit",
  "fed", "federal reserve", "interest rate", "inflation", "cpi",
  "dollar", "treasury", "yield", "recession", "gdp",
  // Market events
  "whale", "sell-off", "rally", "correction", "bull", "bear",
  "all-time high", "ath", "support", "resistance", "liquidation",
  // Geopolitical / macro items that impact BTC
  "trump", "tariff", "china", "cbdc", "reserve", "strategic",
  "sanctions", "ban", "crackdown", "adoption", "legal tender",
  "defi", "nft", "web3",
];

function isBtcRelevant(title) {
  const lower = title.toLowerCase();
  return BTC_RELEVANCE_TERMS.some((term) => lower.includes(term));
}

// ---------------------------------------------------------------------------
// News fetching
// ---------------------------------------------------------------------------

async function fetchRssNews(maxPerFeed = 10) {
  const parser = new RssParser({ requestOptions: { timeout: 10000 } });
  const items = [];
  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      const source = feed.title || url;
      for (const entry of feed.items.slice(0, maxPerFeed)) {
        items.push({
          title:   entry.title || "",
          source,
          pubDate: entry.isoDate ? new Date(entry.isoDate) : null,
        });
      }
    } catch (err) {
      console.warn(`[WARN] RSS feed error (${url}): ${err.message}`);
    }
  }
  return items;
}

async function fetchNewsApiNews(query = "bitcoin cryptocurrency crypto market") {
  if (!NEWS_API_KEY) return [];
  try {
    const res = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: query, language: "en", sortBy: "publishedAt", pageSize: 30, apiKey: NEWS_API_KEY },
      timeout: 10000,
    });
    return res.data.articles.map((a) => ({
      title:   a.title || "",
      source:  a.source?.name || "NewsAPI",
      pubDate: a.publishedAt ? new Date(a.publishedAt) : null,
    }));
  } catch (err) {
    console.warn(`[WARN] NewsAPI error: ${err.message}`);
    return [];
  }
}

async function fetchTrumpPosts() {
  const parser = new RssParser({ requestOptions: { timeout: 10000 } });
  const sources = [
    { url: "https://truthsocial.com/@realDonaldTrump.rss",       label: "Trump/TruthSocial" },
    { url: "https://nitter.privacydev.net/realDonaldTrump/rss",  label: "Trump/X" },
    { url: "https://nitter.poast.org/realDonaldTrump/rss",       label: "Trump/X" },
    { url: "https://nitter.net/realDonaldTrump/rss",             label: "Trump/X" },
  ];
  for (const { url, label } of sources) {
    try {
      const feed = await parser.parseURL(url);
      const items = feed.items
        .slice(0, 15)
        .map((e) => ({
          title:   (e.title || e.contentSnippet || "").replace(/<[^>]+>/g, "").trim().slice(0, 280),
          source:  label,
          pubDate: e.isoDate ? new Date(e.isoDate) : null,
        }))
        .filter((i) => i.title.length > 5);
      if (items.length > 0) return items;
    } catch (_) { /* try next source */ }
  }
  console.warn("[WARN] Could not fetch Trump posts from any source.");
  return [];
}

// ---------------------------------------------------------------------------
// Market data — current BTC price via CoinGecko (free, no key required)
// ---------------------------------------------------------------------------

async function fetchMarketData() {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: {
          ids: "bitcoin",
          vs_currencies: "usd",
          include_24hr_change: true,
          include_24hr_vol: true,
          include_high_low_24h: true, // requires Pro; fall back gracefully if missing
        },
        timeout: 12000,
      }
    );
    const btc = res.data?.bitcoin;
    if (!btc || !btc.usd) throw new Error("No BTC data in CoinGecko response");

    const price     = btc.usd;
    const changePct = btc.usd_24h_change ?? 0;
    const dayHigh   = btc.usd_24h_high ?? price;
    const dayLow    = btc.usd_24h_low  ?? price;
    const volume    = btc.usd_24h_vol  ?? 0;

    return { ticker: "BTC-USD", price, changePct, dayHigh, dayLow, volume, currency: "USD" };
  } catch (err) {
    console.warn(`[WARN] CoinGecko (simple/price) unavailable: ${err.message}`);
  }

  // Fallback: CoinGecko /coins/bitcoin endpoint (more data, slightly heavier)
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/coins/bitcoin", {
      params: { localization: false, tickers: false, community_data: false, developer_data: false },
      timeout: 15000,
    });
    const md = res.data?.market_data;
    if (!md) throw new Error("No market_data in CoinGecko response");
    return {
      ticker:    "BTC-USD",
      price:     md.current_price?.usd ?? 0,
      changePct: md.price_change_percentage_24h ?? 0,
      dayHigh:   md.high_24h?.usd ?? 0,
      dayLow:    md.low_24h?.usd  ?? 0,
      volume:    md.total_volume?.usd ?? 0,
      currency:  "USD",
    };
  } catch (err) {
    console.warn(`[WARN] CoinGecko (coins/bitcoin) unavailable: ${err.message}`);
  }

  console.warn("[WARN] All market data sources unavailable — continuing without price.");
  return null;
}

// ---------------------------------------------------------------------------
// Price history for RSI — daily closes from CoinGecko market chart
// ---------------------------------------------------------------------------

async function fetchPriceHistory(days = 14) {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart", {
      params: { vs_currency: "usd", days, interval: "daily" },
      timeout: 15000,
    });
    // prices: [[timestamp_ms, close], ...]  — daily candles
    const prices = res.data?.prices ?? [];
    // Last entry is the current (incomplete) candle — drop it
    const closes = prices.slice(0, -1).map(([, close]) => close);
    return closes; // oldest-first, length ≈ days
  } catch (err) {
    console.warn(`[WARN] Could not fetch BTC price history: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Momentum score [-100, +100]
// Same formula as brent_crude_signals.js
// ---------------------------------------------------------------------------

function computeMomentum(market, history) {
  if (!market) return { momentumScore: 0, rsi: null };

  // 1. Intraday (24h) change score — scaled ±5% → full ±40 pts
  const changePct = market.changePct ?? 0;
  const intradayScore = Math.max(-40, Math.min(40, (changePct / 5) * 40));

  // 2. Position within 24h range (0 = at low, 1 = at high) → ±20 pts
  let rangeScore = 0;
  const range = (market.dayHigh ?? 0) - (market.dayLow ?? 0);
  if (range > 0) {
    const pos = (market.price - market.dayLow) / range;
    rangeScore = (pos - 0.5) * 40; // ±20
  }

  // 3. RSI(14) → ±40 pts
  let rsi = null;
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

  const momentumScore = Math.round(intradayScore + rangeScore + rsiScore);
  return { momentumScore, rsi };
}

// ---------------------------------------------------------------------------
// Signal analysis — Nemotron via OpenRouter
// ---------------------------------------------------------------------------

function computeNewsHash(items) {
  const content = items.map((i) => i.title).sort().join("\n");
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

async function computeSignal(items, market, history) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set in .env or GitHub Secrets.");
  }

  const newsHash = computeNewsHash(items);

  const headlines = items.map((i) => `- ${i.title} [${i.source}]`).join("\n");

  const priceContext = market
    ? `Current Bitcoin price: $${market.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(2)}% in last 24h).`
    : "Current Bitcoin price: unavailable.";

  const prompt = `You are an expert cryptocurrency market analyst specialising in Bitcoin.

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

${priceContext}

Latest headlines:
${headlines}

Your JSON response:`;

  let parsed;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let content = "";
    try {
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
      content = res.data.choices[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`[WARN] OpenRouter attempt ${attempt} failed (${err.message}) — retrying …`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }

    try {
      parsed = JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
      }
      if (!parsed) {
        const sigMatch = content.match(/\b(BUY|SELL|HOLD)\b/i);
        if (sigMatch) {
          const scoreMatch = content.match(/[-+]?\d+/);
          parsed = {
            signal:    sigMatch[1].toUpperCase(),
            netScore:  scoreMatch ? parseInt(scoreMatch[0], 10) : 0,
            reasoning: content.slice(0, 120).replace(/\n/g, " "),
          };
        }
      }
    }

    if (parsed) break;
    console.warn(`[WARN] Attempt ${attempt}: unparse-able response ("${content.slice(0, 60)}") — retrying …`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  if (!parsed) throw new Error("Nemotron returned invalid JSON after 3 attempts.");

  const aiSignal = ["BUY", "HOLD", "SELL"].includes(parsed.signal) ? parsed.signal : "HOLD";
  const aiScore  = typeof parsed.netScore === "number" ? parsed.netScore : 0;

  // 90/10 blend
  const { momentumScore, rsi } = computeMomentum(market, history);
  const blendedScore = Math.round(aiScore * 0.9 + momentumScore * 0.1);
  const signal = blendedScore > 15 ? "BUY" : blendedScore < -15 ? "SELL" : "HOLD";

  console.log(`  ${C.dim}Nemotron reasoning: ${parsed.reasoning}${C.reset}`);
  const rsiStr = rsi !== null ? `RSI ${rsi.toFixed(1)}` : "RSI n/a";
  console.log(`  ${C.dim}Momentum score: ${momentumScore >= 0 ? "+" : ""}${momentumScore}  (${rsiStr})  →  AI ${aiScore >= 0 ? "+" : ""}${aiScore}  →  Blended ${blendedScore >= 0 ? "+" : ""}${blendedScore}${C.reset}\n`);

  return { signal, netScore: blendedScore, aiScore, momentumScore, rsi, newsHash };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function printHeader(mode) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const modeStr = col(C.green, `[${mode}]`);
  console.log(`\n${C.bold}${"=".repeat(65)}${C.reset}`);
  console.log(`${C.bold}  Bitcoin Signal  →  Trading 212  ${modeStr}  ${C.dim}${now}${C.reset}`);
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
      console.warn("  [WARN] Account info requires 'Read account' permission.\n");
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
  console.log(`  ${C.bold}Bitcoin (${market.ticker})${C.reset}`);
  console.log(`  Price  : ${C.bold}${market.currency} ${market.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}${C.reset}  (${col(chgColor, `${sign}${market.changePct.toFixed(2)}%`)})`);
  console.log(`  24h Hi : ${market.dayHigh?.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  console.log(`  24h Lo : ${market.dayLow?.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  console.log(`  Volume : $${(market.volume / 1e9).toFixed(2)}B\n`);
}

function printSignal(signal, netScore) {
  const sigColor = signal === "BUY" ? C.green : signal === "SELL" ? C.red : C.yellow;
  console.log(`  ${C.bold}Signal    : ${col(sigColor, signal)}${col(C.dim, " (via Nemotron-3-Super-120B)")}${C.reset}`);
  console.log(`  Net score : ${netScore >= 0 ? "+" : ""}${netScore}\n`);
}

function printTopItems(items, topN = 75) {
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
  console.log(`  Cryptocurrency trading involves substantial risk of loss.${C.reset}`);
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
      console.error("[ERROR] Authentication failed (401). Check your API key/secret.");
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

  console.log("[INFO] Fetching BTC market data …");
  const market = await fetchMarketData();

  console.log("[INFO] Fetching RSS news …");
  let items = await fetchRssNews();

  console.log("[INFO] Fetching NewsAPI headlines …");
  items = items.concat(await fetchNewsApiNews());

  console.log("[INFO] Fetching Trump posts …");
  items = items.concat(await fetchTrumpPosts());

  const before = items.length;
  const cutoff = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5-hour recency window
  items = items.filter((i) => isBtcRelevant(i.title) && (!i.pubDate || i.pubDate >= cutoff));
  console.log(`[INFO] Fetched ${before} articles, ${items.length} BTC-relevant within last 5h …`);

  console.log("[INFO] Fetching BTC price history for momentum …");
  const history = await fetchPriceHistory(14);

  const { signal, netScore, aiScore, momentumScore, rsi, newsHash } = await computeSignal(items, market, history);

  printMarket(market);
  printSignal(signal, netScore);
  printTopItems(items);

  let orderResult = null;
  if (execute && client) {
    let lastNewsHash = null;
    try {
      const { readFile } = await import("node:fs/promises");
      const last = JSON.parse(await readFile("last_btc_signal.json", "utf8"));
      if (last.order) lastNewsHash = last.newsHash ?? null;
    } catch (_) { /* no previous state file */ }

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
    aiScore,
    momentumScore,
    rsi: rsi !== null ? parseFloat(rsi.toFixed(1)) : null,
    newsHash,
    price:     market?.price ?? null,
    changePct: market ? parseFloat(market.changePct.toFixed(2)) : null,
    order:     orderResult,
    relevantHeadlines: items
      .slice(0, 10)
      .map(({ title, source }) => ({ title, source })),
  };

  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile("last_btc_signal.json", JSON.stringify(output, null, 2));
  } catch (err) {
    console.warn(`[WARN] Could not write last_btc_signal.json: ${err.message}`);
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
  .name("bitcoin_signals")
  .description("Bitcoin signal analyzer + Trading 212 paper trading executor")
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
      console.error("ERROR: T212_API_KEY and T212_SECRET_KEY must be set in .env or as GitHub Secrets.");
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
    process.exit(0);
  }
})();
