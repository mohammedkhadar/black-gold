import axios from "axios";
import type { MarketData } from "../lib/types.js";

// yahoo-finance2 is an optional fallback — import dynamically to avoid hard crash if unavailable
let _yfModule: { default: { quote: (t: string, ...a: unknown[]) => Promise<YFQuote> } } | null = null;

interface YFQuote {
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  currency?: string;
  regularMarketChangePercent?: number;
}

async function getYahooFinance(): Promise<typeof _yfModule> {
  if (_yfModule) return _yfModule;
  try {
    _yfModule = await import("yahoo-finance2") as unknown as typeof _yfModule;
  } catch {
    _yfModule = null;
  }
  return _yfModule;
}

export async function fetchMarketData(): Promise<MarketData | null> {
  // Primary: Stooq CSV
  const stooqSymbols = ["cb.f", "cl.f"];
  for (const sym of stooqSymbols) {
    try {
      const res = await axios.get<string>(
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[WARN] Stooq unavailable for ${sym}: ${msg}`);
    }
  }

  // Fallback: yahoo-finance2
  const yf = await getYahooFinance();
  if (yf) {
    for (const ticker of ["BZ=F", "CL=F"]) {
      try {
        const quote = await Promise.race([
          yf.default.quote(ticker, undefined, { validateResult: false }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
        ]);
        if (!quote?.regularMarketPrice) continue;
        return {
          ticker,
          price:     quote.regularMarketPrice,
          prevClose: quote.regularMarketPreviousClose,
          dayHigh:   quote.regularMarketDayHigh ?? 0,
          dayLow:    quote.regularMarketDayLow  ?? 0,
          volume:    quote.regularMarketVolume   ?? 0,
          currency:  quote.currency              ?? "USD",
          changePct: quote.regularMarketChangePercent ?? 0,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[WARN] Yahoo Finance unavailable for ${ticker}: ${msg}`);
      }
    }
  }

  console.warn("[WARN] All market data sources unavailable — continuing without price.");
  return null;
}

export async function fetchPriceHistory(days = 14): Promise<number[]> {
  try {
    const res = await axios.get<string>("https://stooq.com/q/d/l/?s=cb.f&i=d", { timeout: 12000 });
    const lines = res.data.trim().split("\n").filter((l) => l.trim());
    // header: Date,Open,High,Low,Close,Volume
    const closes: number[] = [];
    for (let i = lines.length - 1; i >= 1 && closes.length < days; i--) {
      const cols = lines[i].split(",");
      const c = parseFloat(cols[4]);
      if (c > 0) closes.unshift(c); // oldest first
    }
    return closes;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WARN] Could not fetch price history: ${msg}`);
    return [];
  }
}
