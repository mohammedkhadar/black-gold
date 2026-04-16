export const DEFAULT_TICKER   = "EBRTm_EQ";
export const MAX_ORDER_QTY    = 1000;
export const STOP_LOSS_PCT    = 3;
export const TAKE_PROFIT_PCT  = 5;
export const NEWS_API_QUERY   = "oil brent crude geopolitical";
export const AI_BLEND         = { ai: 0.5, momentum: 0.5 };

export const RSS_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://rss.dw.com/rdf/rss-en-world",
  "https://www.aljazeera.com/xml/rss/all.xml",
  "https://news.google.com/rss/search?q=brent+crude+oil&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=oil+OPEC+geopolitical&hl=en-US&gl=US&ceid=US:en",
];

const RELEVANCE_TERMS = [
  "oil", "crude", "brent", "wti", "opec", "petroleum", "gasoline", "fuel", "lng",
  "natural gas", "energy", "refiner", "barrel",
  "supply", "demand", "inventory", "stockpile", "production", "output", "export",
  "import", "pipeline", "tanker", "shipping",
  "iran", "iraq", "saudi", "russia", "ukraine", "libya", "venezuela", "nigeria",
  "hormuz", "strait", "gulf", "middle east", "yemen", "houthi",
  "israel", "gaza", "sanctions", "embargo",
  "fed", "federal reserve", "interest rate", "inflation", "recession", "gdp",
  "dollar", "tariff", "trade war", "china", "demand", "growth",
  "trump", "drill", "fracking", "SPR", "strategic reserve",
];

export function isRelevant(title) {
  const lower = title.toLowerCase();
  return RELEVANCE_TERMS.some((term) => lower.includes(term));
}
