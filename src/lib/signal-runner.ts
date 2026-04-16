import { Trading212Client } from "./t212.js";
import { fetchRssNews, fetchNewsApiNews, fetchTrumpPosts } from "./news.js";
import { computeSignal } from "./signal.js";
import { createRedisClient } from "./redis.js";
import { createTelegramClient } from "./telegram.js";
import { printAccountInfo, printPositionInfo, printSignal, printTopItems, printDisclaimer, printMarketData, printHeader } from "./display.js";
import { executeSignal, runLoop } from "./execution.js";
import { NEWS_CUTOFF_MS, STOP_LOSS_PCT, TAKE_PROFIT_PCT, MAX_ORDER_QTY } from "./config.js";
import type { MarketData, AIBlend, NewsItem, RedisClient, TelegramClient, Signal } from "./types.js";

export interface SignalConfig {
  name: string;
  ticker: string;
  priceContext: (market: MarketData | null) => string;
  priceFormatter: (p: number) => string;
  disclaimer: string;
  redisPrefix: string;
  buildPrompt: (headlines: string, market: MarketData | null) => string;
  isRelevant: (title: string) => boolean;
  rssFeeds: string[];
  newsApiQuery: string;
  aiBlend: AIBlend;
}

export interface SignalDependencies {
  openRouterApiKey: string;
  groqApiKey: string;
  newsApiKey: string;
}

export interface RunOnceOptions {
  client: Trading212Client | null;
  ticker: string;
  orderQty: number;
  execute: boolean;
  autoConfirm: boolean;
}

function formatPct(value: number, decimals: number = 2): string {
  return value.toFixed(decimals);
}

function formatPrice(price: number, formatter: (p: number) => string): string {
  return `$${formatter(price)}`;
}

function formatSignalMessage(
  emoji: string,
  name: string,
  signal: string,
  market: MarketData | null,
  netScore: number,
  aiScore: number,
  momentumScore: number,
  reasoning: string | null,
  priceFormatter: (p: number) => string
): string {
  const priceStr = market
    ? ` @ ${formatPrice(market.price, priceFormatter)} (${market.changePct >= 0 ? "+" : ""}${formatPct(market.changePct)}%)`
    : "";

  return (
    `${emoji} <b>${name} ${signal}</b>${priceStr}\n` +
    `Score: ${netScore >= 0 ? "+" : ""}${netScore}  (AI ${aiScore >= 0 ? "+" : ""}${aiScore} / Mom ${momentumScore >= 0 ? "+" : ""}${momentumScore})\n` +
    `${reasoning ? `Reasoning: ${reasoning}\n` : ""}` +
    `Time: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`
  );
}

async function checkRiskOverrides(
  execute: boolean,
  client: Trading212Client | null,
  ticker: string,
  signal: string,
  market: MarketData | null,
  telegram: TelegramClient,
  priceFormatter: (p: number) => string
): Promise<{ signal: string; riskOverride: boolean }> {
  if (!execute || !client || !market) {
    return { signal, riskOverride: false };
  }

  try {
    const riskPos = await client.getPosition(ticker);
    if (!riskPos || parseFloat(riskPos.quantity) <= 0) {
      return { signal, riskOverride: false };
    }

    const entry   = parseFloat(riskPos.averagePrice);
    const current = parseFloat(riskPos.currentPrice);
    const pct     = entry > 0 ? ((current - entry) / entry) * 100 : 0;

    if (pct <= -STOP_LOSS_PCT) {
      console.log(`[RISK] Stop-loss triggered: ${formatPct(pct)}% from entry ${formatPrice(entry, priceFormatter)} — forcing SELL`);
      await telegram.send(
        `🛑 <b>Stop-loss triggered</b>\n` +
        `<code>${ticker}</code>  Entry: ${formatPrice(entry, priceFormatter)}  Now: ${formatPrice(current, priceFormatter)}  (${formatPct(pct)}%)`
      );
      return { signal: "SELL", riskOverride: true };
    }

    if (pct >= TAKE_PROFIT_PCT) {
      console.log(`[RISK] Take-profit triggered: +${formatPct(pct)}% from entry ${formatPrice(entry, priceFormatter)} — forcing SELL`);
      await telegram.send(
        `💰 <b>Take-profit triggered</b>\n` +
        `<code>${ticker}</code>  Entry: ${formatPrice(entry, priceFormatter)}  Now: ${formatPrice(current, priceFormatter)}  (+${formatPct(pct)}%)`
      );
      return { signal: "SELL", riskOverride: true };
    }
  } catch { /* no open position or fetch failed */ }

  return { signal, riskOverride: false };
}

export async function runSignal(
  config: SignalConfig,
  deps: SignalDependencies,
  opts: RunOnceOptions,
  fetchMarketData: () => Promise<MarketData | null>,
  fetchPriceHistory: (days: number) => Promise<number[]>
): Promise<Record<string, unknown>> {
  const { name, ticker, priceFormatter, disclaimer, redisPrefix, buildPrompt, isRelevant, rssFeeds, newsApiQuery, aiBlend } = config;
  const { client, orderQty, execute, autoConfirm } = opts;

  const redis    = createRedisClient(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN);
  const telegram = createTelegramClient(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);

  printHeader(`${name} Signal`, client ? client.mode : "SIGNAL-ONLY");

  if (client) {
    await printAccountInfo(client);
    await printPositionInfo(client, ticker);
  }

  console.log(`[INFO] Fetching ${name} market data …`);
  const market = await fetchMarketData();

  console.log("[INFO] Fetching RSS news …");
  let items: NewsItem[] = await fetchRssNews(rssFeeds);

  console.log("[INFO] Fetching NewsAPI headlines …");
  items = items.concat(await fetchNewsApiNews(newsApiQuery, deps.newsApiKey));

  console.log("[INFO] Fetching Trump posts …");
  items = items.concat(await fetchTrumpPosts());

  const before = items.length;
  const cutoff = new Date(Date.now() - NEWS_CUTOFF_MS);
  items = items.filter((i) => isRelevant(i.title) && (!i.pubDate || i.pubDate >= cutoff));
  console.log(`[INFO] Fetched ${before} articles, ${items.length} relevant within last 5h …`);

  console.log(`[INFO] Fetching ${name} price history for momentum …`);
  const history = await fetchPriceHistory(14);

  const signalResult = await computeSignal(items, market, history, buildPrompt, aiBlend, deps.openRouterApiKey, deps.groqApiKey);

  let { signal, netScore, aiScore, momentumScore, rsi, newsHash, reasoning } = signalResult;

  printMarketData(market, name, priceFormatter);
  printSignal(signal, netScore);
  printTopItems(items);

  const { signal: riskSignal, riskOverride } = await checkRiskOverrides(execute, client, ticker, signal, market, telegram, priceFormatter);
  signal = riskSignal as Signal;

  if (signal !== "HOLD" && !riskOverride) {
    const emoji = signal === "BUY" ? "🟢" : "🔴";
    await telegram.send(formatSignalMessage(emoji, name, signal, market, netScore, aiScore, momentumScore, reasoning, priceFormatter));
  }

  let orderResult = null;
  if (execute && client) {
    const lastNewsHash = await redis.get(`${redisPrefix}:lastNewsHash`);
    if (lastNewsHash && lastNewsHash === newsHash) {
      console.log(`[INFO] News unchanged (hash: ${newsHash}) — skipping order.`);
    } else {
      if (lastNewsHash) console.log(`[INFO] News changed (${lastNewsHash} → ${newsHash}) — proceeding.`);
      orderResult = await executeSignal({ client, signal, ticker, orderQty, autoConfirm, maxOrderQty: MAX_ORDER_QTY, telegram });
    }
  }

  printDisclaimer(disclaimer);

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

  await redis.set(`${redisPrefix}:lastNewsHash`, newsHash);
  await redis.append(`${redisPrefix}:history`, JSON.stringify({ ...output, reasoning }));

  return output;
}

export { runLoop };

