export const DEFAULT_TICKER   = "IB1Tl_EQ";
export const MAX_ORDER_QTY    = 1000;
export const STOP_LOSS_PCT    = 3;
export const TAKE_PROFIT_PCT  = 5;
export const NEWS_API_QUERY   = "bitcoin cryptocurrency crypto market";
export const AI_BLEND         = { ai: 0.9, momentum: 0.1 };

export const RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://bitcoinmagazine.com/feed",
  "https://news.google.com/rss/search?q=bitcoin+crypto&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=bitcoin+regulation+ETF+SEC&hl=en-US&gl=US&ceid=US:en",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
];

const RELEVANCE_TERMS = [
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

export function isRelevant(title) {
  const lower = title.toLowerCase();
  return RELEVANCE_TERMS.some((term) => lower.includes(term));
}
