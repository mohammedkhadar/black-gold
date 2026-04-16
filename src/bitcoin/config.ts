import type { AIBlend } from "../lib/types.js";
import { MAX_ORDER_QTY, STOP_LOSS_PCT, TAKE_PROFIT_PCT } from "../lib/config.js";

export { MAX_ORDER_QTY, STOP_LOSS_PCT, TAKE_PROFIT_PCT };

export const DEFAULT_TICKER: string  = "IB1Tl_EQ";
export const NEWS_API_QUERY: string  = "bitcoin cryptocurrency crypto market";
export const AI_BLEND: AIBlend       = { ai: 0.8, momentum: 0.2 };

export const RSS_FEEDS: string[] = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://bitcoinmagazine.com/feed",
  "https://news.google.com/rss/search?q=bitcoin+crypto&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=bitcoin+regulation+ETF+SEC&hl=en-US&gl=US&ceid=US:en",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
];

const RELEVANCE_TERMS: string[] = [
  "bitcoin", "btc", "crypto", "cryptocurrency", "blockchain", "satoshi",
  "halving", "mining", "miner", "hash rate", "lightning network",
  "ethereum", "eth", "altcoin", "stablecoin", "usdt", "usdc", "tether",
  "binance", "coinbase", "kraken", "bybit", "okx",
  "sec", "regulation", "regulatory", "etf", "spot etf", "futures",
  "blackrock", "fidelity", "grayscale", "gbtc", "ibit",
  "fed", "federal reserve", "interest rate", "inflation", "cpi",
  "dollar", "treasury", "yield", "recession", "gdp",
  "whale", "sell-off", "rally", "correction", "bull", "bear",
  "all-time high", "ath", "support", "resistance", "liquidation",
  "trump", "tariff", "china", "cbdc", "reserve", "strategic",
  "sanctions", "ban", "crackdown", "adoption", "legal tender",
  "defi", "nft", "web3",
];

export function isRelevant(title: string): boolean {
  const lower = title.toLowerCase();
  return RELEVANCE_TERMS.some((term) => lower.includes(term));
}
