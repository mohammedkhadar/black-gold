import axios from "axios";
import yahooFinance from "yahoo-finance2";

// yahoo-finance2 v2 exports the class as default; create one instance.
// Falls back to Stooq CSV if Yahoo rate-limits (429).
let _yfInstance = null;
try { _yfInstance = new yahooFinance.default(); } catch (_) { /* will use Stooq fallback only */ }

export async function fetchMarketData() {
  // Primary: Stooq CSV (no auth, no rate limits) — CB.F = Brent, CL.F = WTI
  const stooqSymbols = ["cb.f", "cl.f"];
  for (const sym of stooqSymbols) {
    try {
      const res = await axios.get(
        `https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`,
        { timeout: 10000 }
      );
      const lines = res.data.trim().split("\n");
      if (lines.length < 2) continue;
      // cols: Symbol,Date,Time,Open,High,Low,Close,Volume
      const cols  = lines[1].split(",");
      const price = parseFloat(cols[6]);
      const open  = parseFloat(cols[3]);
      if (!price || price === 0) continue;
      return {
        ticker:    decodeURIComponent(sym),
        price,
        prevClose: open,
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

export async function fetchPriceHistory(days = 14) {
  // Stooq daily history (newest-first rows)
  try {
    const res = await axios.get("https://stooq.com/q/d/l/?s=cb.f&i=d", { timeout: 12000 });
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
