import axios from "axios";
import type { MarketData } from "../lib/types.js";

export async function fetchMarketData(): Promise<MarketData | null> {
  // Primary: CoinGecko simple/price endpoint
  try {
    const res = await axios.get<{
      bitcoin?: {
        usd?: number;
        usd_24h_change?: number;
        usd_24h_high?: number;
        usd_24h_low?: number;
        usd_24h_vol?: number;
      };
    }>("https://api.coingecko.com/api/v3/simple/price", {
      params: {
        ids: "bitcoin",
        vs_currencies: "usd",
        include_24hr_change: true,
        include_24hr_vol: true,
        include_high_low_24h: true,
      },
      timeout: 12000,
    });
    const btc = res.data?.bitcoin;
    if (!btc || !btc.usd) throw new Error("No BTC data in CoinGecko response");
    return {
      ticker:    "BTC-USD",
      price:     btc.usd,
      changePct: btc.usd_24h_change ?? 0,
      dayHigh:   btc.usd_24h_high ?? btc.usd,
      dayLow:    btc.usd_24h_low  ?? btc.usd,
      volume:    btc.usd_24h_vol  ?? 0,
      currency:  "USD",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WARN] CoinGecko (simple/price) unavailable: ${msg}`);
  }

  // Fallback: CoinGecko /coins/bitcoin
  try {
    const res = await axios.get<{
      market_data?: {
        current_price?: { usd?: number };
        price_change_percentage_24h?: number;
        high_24h?: { usd?: number };
        low_24h?: { usd?: number };
        total_volume?: { usd?: number };
      };
    }>("https://api.coingecko.com/api/v3/coins/bitcoin", {
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WARN] CoinGecko (coins/bitcoin) unavailable: ${msg}`);
  }

  console.warn("[WARN] All market data sources unavailable — continuing without price.");
  return null;
}

export async function fetchPriceHistory(days = 14): Promise<number[]> {
  try {
    const res = await axios.get<{ prices?: [number, number][] }>(
      "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart",
      { params: { vs_currency: "usd", days, interval: "daily" }, timeout: 15000 }
    );
    // prices: [[timestamp_ms, close], ...] — drop the last (incomplete) candle
    return (res.data?.prices ?? []).slice(0, -1).map(([, c]) => c);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WARN] Could not fetch BTC price history: ${msg}`);
    return [];
  }
}
