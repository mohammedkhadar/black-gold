import axios from "axios";

export async function fetchMarketData() {
  // Primary: CoinGecko simple/price endpoint
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
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
  } catch (err) {
    console.warn(`[WARN] CoinGecko (simple/price) unavailable: ${err.message}`);
  }

  // Fallback: CoinGecko /coins/bitcoin
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

export async function fetchPriceHistory(days = 14) {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart", {
      params: { vs_currency: "usd", days, interval: "daily" },
      timeout: 15000,
    });
    // prices: [[timestamp_ms, close], ...] — drop the last (incomplete) candle
    const closes = (res.data?.prices ?? []).slice(0, -1).map(([, c]) => c);
    return closes;
  } catch (err) {
    console.warn(`[WARN] Could not fetch BTC price history: ${err.message}`);
    return [];
  }
}
