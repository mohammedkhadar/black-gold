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

// Hard process-exit guard — prevents CI jobs hanging indefinitely
setTimeout(() => {
  console.warn("[WARN] Process timeout reached (4 min) — forcing exit.");
  process.exit(0);
}, 4 * 60 * 1000);

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

const T212_API_KEY       = process.env.T212_API_KEY;
const T212_API_SECRET    = process.env.T212_SECRET_KEY;
const NEWS_API_KEY       = process.env.NEWS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const UPSTASH_URL        = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN      = process.env.UPSTASH_REDIS_REST_TOKEN;

const T212_BASE       = "https://demo.trading212.com/api/v0";

const DEFAULT_TICKER  = "EBRTm_EQ"; // WisdomTree Brent Crude Oil - EUR Daily Hedged (T212 paper)
const MAX_ORDER_QTY   = 1000;       // hard cap on quantity per order
const STOP_LOSS_PCT   = 3;          // close if position is down ≥ 3% from entry
const TAKE_PROFIT_PCT = 5;          // close if position is up ≥ 5% from entry

const RSS_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://rss.dw.com/rdf/rss-en-world",
  "https://www.aljazeera.com/xml/rss/all.xml",
  // Google News RSS — free, no key, aggregates Reuters/AP/FT/Bloomberg
  "https://news.google.com/rss/search?q=brent+crude+oil&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=oil+OPEC+geopolitical&hl=en-US&gl=US&ceid=US:en",
  // Iranian perspective — directly relevant for Hormuz/sanctions/supply risk
  //"https://www.presstv.ir/rss.xml",   // Press TV (Iran state English broadcaster)
  "https://en.irna.ir/rss",           // IRNA (Islamic Republic News Agency)
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
// News relevance filter
// ---------------------------------------------------------------------------

const OIL_RELEVANCE_TERMS = [
  // Commodities & energy
  "oil", "crude", "brent", "wti", "opec", "petroleum", "gasoline", "fuel", "lng",
  "natural gas", "energy", "refiner", "barrel",
  // Supply & demand drivers
  "supply", "demand", "inventory", "stockpile", "production", "output", "export",
  "import", "pipeline", "tanker", "shipping",
  // Geopolitical hotspots
  "iran", "iraq", "saudi", "russia", "ukraine", "libya", "venezuela", "nigeria",
  "opec", "hormuz", "strait", "gulf", "middle east", "yemen", "houthi",
  "israel", "gaza", "sanctions", "embargo",
  // Macro / markets
  "fed", "federal reserve", "interest rate", "inflation", "recession", "gdp",
  "dollar", "tariff", "trade war", "china", "demand", "growth",
  // Trump / policy keywords likely to move oil
  "trump", "tariff", "drill", "fracking", "pipeline", "SPR", "strategic reserve",
];

function isOilRelevant(title) {
  const lower = title.toLowerCase();
  return OIL_RELEVANCE_TERMS.some((term) => lower.includes(term));
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

async function fetchNewsApiNews(query = "oil brent crude geopolitical") {
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
  const parser = new RssParser();
  // Truth Social (Mastodon-based) has native RSS; Nitter instances as fallback for X
  const sources = [
    { url: "https://truthsocial.com/@realDonaldTrump.rss",        label: "Trump/TruthSocial" },
    { url: "https://nitter.privacydev.net/realDonaldTrump/rss",   label: "Trump/X" },
    { url: "https://nitter.poast.org/realDonaldTrump/rss",        label: "Trump/X" },
    { url: "https://nitter.net/realDonaldTrump/rss",              label: "Trump/X" },
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
// Market data — multi-day history for momentum
// ---------------------------------------------------------------------------

async function fetchPriceHistory(days = 14) {
  // Stooq daily history: returns newest-first CSV rows
  try {
    const res = await axios.get(
      `https://stooq.com/q/d/l/?s=cb.f&i=d`,
      { timeout: 12000 }
    );
    const lines = res.data.trim().split("\n").filter((l) => l.trim());
    // header: Date,Open,High,Low,Close,Volume
    const closes = [];
    for (let i = lines.length - 1; i >= 1 && closes.length < days; i--) {
      const cols = lines[i].split(",");
      const c = parseFloat(cols[4]);
      if (c > 0) closes.unshift(c); // oldest first
    }
    return closes;
  } catch (err) {
    console.warn(`[WARN] Could not fetch price history: ${err.message}`);
    return [];
  }
}

/**
 * Momentum score in range [-100, +100].
 * Combines:
 *  - Intraday change (±40 pts, scaled ±5% → full weight)
 *  - Position within day range (±20 pts)
 *  - 14-day RSI (±40 pts, RSI 70→+40, RSI 30→-40, 50→0)
 */
function computeMomentum(market, history) {
  if (!market) return { momentumScore: 0, rsi: null };

  // 1. Intraday change score
  const changePct = market.changePct ?? 0;
  const intradayScore = Math.max(-40, Math.min(40, (changePct / 5) * 40));

  // 2. Price position within day's range (closer to high = bullish)
  let rangeScore = 0;
  const range = (market.dayHigh ?? 0) - (market.dayLow ?? 0);
  if (range > 0) {
    const pos = (market.price - market.dayLow) / range; // 0=at low, 1=at high
    rangeScore = (pos - 0.5) * 40; // ±20
  }

  // 3. RSI(14) from close history
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
    // RSI 70 → +40, RSI 30 → -40, RSI 50 → 0 (linear)
    rsiScore = Math.max(-40, Math.min(40, (rsi - 50) * (40 / 20)));
  }

  const momentumScore = Math.round(intradayScore + rangeScore + rsiScore);
  return { momentumScore, rsi };
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
async function computeSignal(items, market, history) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set in .env or GitHub Secrets.");
  }

  const newsHash = computeNewsHash(items);

  const headlines = items
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

  // Retry up to 3 times on bad/empty responses
  let parsed;
  let aiAvailable = true;
  const MODELS = [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "moonshotai/kimi-k2:free",
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    let content = "";
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: MODELS[attempt - 1],
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
      if (attempt === 3) {
        console.warn(`[WARN] All OpenRouter attempts failed (${err.message}) — defaulting to HOLD.`);
        break;
      }
      console.warn(`[WARN] OpenRouter attempt ${attempt} (${MODELS[attempt-1]}) failed (${err.message}) — retrying …`);
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
            signal: sigMatch[1].toUpperCase(),
            netScore: scoreMatch ? parseInt(scoreMatch[0], 10) : 0,
            reasoning: content.slice(0, 120).replace(/\n/g, " "),
          };
        }
      }
    }

    if (parsed) break;
    console.warn(`[WARN] Attempt ${attempt}: unparse-able response ("${content.slice(0, 60)}") — retrying …`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  if (!parsed) {
    console.warn("[WARN] AI signal unavailable — defaulting to HOLD with score 0.");
    parsed = { signal: "HOLD", netScore: 0, reasoning: "AI unavailable — rate limited." };
    aiAvailable = false;
  }
  const aiSignal = ["BUY", "HOLD", "SELL"].includes(parsed.signal) ? parsed.signal : "HOLD";
  const aiScore  = typeof parsed.netScore === "number" ? parsed.netScore : 0;

  // Blend AI score (50%) with momentum score (50%)
  const { momentumScore, rsi } = computeMomentum(market, history);
  const blendedScore = Math.round(aiScore * 0.5 + momentumScore * 0.5);
  const signal = !aiAvailable ? "HOLD" : blendedScore > 15 ? "BUY" : blendedScore < -15 ? "SELL" : "HOLD";

  console.log(`  ${C.dim}Nemotron reasoning: ${parsed.reasoning}${C.reset}`);
  const rsiStr = rsi !== null ? `RSI ${rsi.toFixed(1)}` : "RSI n/a";
  console.log(`  ${C.dim}Momentum score: ${momentumScore >= 0 ? "+" : ""}${momentumScore}  (${rsiStr})  →  AI ${aiScore >= 0 ? "+" : ""}${aiScore}  →  Blended ${blendedScore >= 0 ? "+" : ""}${blendedScore}${C.reset}\n`);
  return { signal, netScore: blendedScore, aiScore, momentumScore, rsi, newsHash, reasoning: parsed.reasoning ?? "" };
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
  console.log(`  Trading involves substantial risk of loss.${C.reset}`);
  console.log(`${C.dim}${"─".repeat(65)}${C.reset}\n`);
}

// ---------------------------------------------------------------------------
// Telegram notifications
// ---------------------------------------------------------------------------

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" },
      { timeout: 10000 }
    );
  } catch (err) {
    console.warn(`[WARN] Telegram notification failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Upstash Redis helpers (CI-safe persistent state)
// ---------------------------------------------------------------------------

async function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await axios.post(UPSTASH_URL, ["GET", key], {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      timeout: 10000,
    });
    return res.data?.result ?? null;
  } catch (err) {
    console.warn(`[WARN] Redis GET failed: ${err.message}`);
    return null;
  }
}

async function redisSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await axios.post(UPSTASH_URL, ["SET", key, String(value)], {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      timeout: 10000,
    });
  } catch (err) {
    console.warn(`[WARN] Redis SET failed: ${err.message}`);
  }
}

async function redisAppend(listKey, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await axios.post(UPSTASH_URL, ["RPUSH", listKey, String(value)], {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      timeout: 10000,
    });
  } catch (err) {
    console.warn(`[WARN] Redis RPUSH failed: ${err.message}`);
  }
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
    await sendTelegram(
      `✅ <b>Order placed</b> — ${client.mode}\n` +
      `Ticker: <code>${ticker}</code>  qty: ${sellQty}\n` +
      `Order ID: <code>${order.id ?? "?"}</code>`
    );
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

  console.log("[INFO] Fetching Trump posts …");
  items = items.concat(await fetchTrumpPosts());

  const before = items.length;
  const cutoff = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
  items = items.filter((i) => isOilRelevant(i.title) && (!i.pubDate || i.pubDate >= cutoff));
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
          await sendTelegram(`🛑 <b>Stop-loss triggered</b>\n<code>${ticker}</code>  Entry: $${entry.toFixed(2)}  Now: $${market.price.toFixed(2)}  (${pct.toFixed(2)}%)`);
          signal = "SELL";
          riskOverride = true;
        } else if (pct >= TAKE_PROFIT_PCT) {
          console.log(`[RISK] Take-profit triggered: +${pct.toFixed(2)}% from entry $${entry} — forcing SELL`);
          await sendTelegram(`💰 <b>Take-profit triggered</b>\n<code>${ticker}</code>  Entry: $${entry.toFixed(2)}  Now: $${market.price.toFixed(2)}  (+${pct.toFixed(2)}%)`);
          signal = "SELL";
          riskOverride = true;
        }
      }
    } catch (_) { /* no position or fetch failed */ }
  }

  // Send Telegram notification for BUY/SELL only (skip if risk override already notified)
  if (signal !== "HOLD" && !riskOverride) {
    const emoji = signal === "BUY" ? "🟢" : "🔴";
    const priceStr = market ? ` @ $${market.price.toFixed(2)} (${market.changePct >= 0 ? "+" : ""}${market.changePct.toFixed(2)}%)` : "";
    await sendTelegram(
      `${emoji} <b>Brent Crude ${signal}</b>${priceStr}\n` +
      `Score: ${netScore >= 0 ? "+" : ""}${netScore}  (AI ${aiScore >= 0 ? "+" : ""}${aiScore} / Mom ${momentumScore >= 0 ? "+" : ""}${momentumScore})\n` +
      `${reasoning ? `Reasoning: ${reasoning}\n` : ""}` +
      `Time: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`
    );
  }

  let orderResult = null;
  if (execute && client) {
    const lastNewsHash = await redisGet("brent:lastNewsHash");

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
    price:      market?.price ?? null,
    changePct:  market ? parseFloat(market.changePct.toFixed(2)) : null,
    order:      orderResult,
    relevantHeadlines: items
      .slice(0, 10)
      .map(({ title, source }) => ({ title, source })),
  };

  // Persist hash and history to Redis
  await redisSet("brent:lastNewsHash", newsHash);
  await redisAppend("brent:history", JSON.stringify({ ...output, reasoning }));

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
