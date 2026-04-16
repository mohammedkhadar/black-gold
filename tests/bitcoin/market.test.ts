import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchMarketData, fetchPriceHistory } from "../../src/bitcoin/market.js";

vi.mock("axios");
import axios from "axios";
const mockGet = vi.mocked(axios.get);

describe("bitcoin/market", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("fetchMarketData", () => {
    it("returns market data from CoinGecko simple/price", async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          bitcoin: {
            usd: 84000,
            usd_24h_change: 2.5,
            usd_24h_high: 85000,
            usd_24h_low: 83000,
            usd_24h_vol: 50000000000,
          },
        },
      });
      const data = await fetchMarketData();
      expect(data).not.toBeNull();
      expect(data?.price).toBe(84000);
      expect(data?.changePct).toBe(2.5);
      expect(data?.ticker).toBe("BTC-USD");
      expect(data?.currency).toBe("USD");
    });

    it("falls back to /coins/bitcoin when simple/price fails", async () => {
      mockGet
        .mockRejectedValueOnce(new Error("rate limited"))
        .mockResolvedValueOnce({
          data: {
            market_data: {
              current_price: { usd: 83000 },
              price_change_percentage_24h: -1.2,
              high_24h: { usd: 84000 },
              low_24h: { usd: 82000 },
              total_volume: { usd: 45000000000 },
            },
          },
        });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const data = await fetchMarketData();
      expect(data?.price).toBe(83000);
      expect(data?.changePct).toBe(-1.2);
      warnSpy.mockRestore();
    });

    it("returns null when all sources fail", async () => {
      mockGet
        .mockRejectedValueOnce(new Error("error 1"))
        .mockRejectedValueOnce(new Error("error 2"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const data = await fetchMarketData();
      expect(data).toBeNull();
      warnSpy.mockRestore();
    });
  });

  describe("fetchPriceHistory", () => {
    it("returns array of closing prices", async () => {
      const prices = Array.from({ length: 15 }, (_, i) => [Date.now() + i * 86400000, 80000 + i * 100] as [number, number]);
      mockGet.mockResolvedValueOnce({ data: { prices } });
      const history = await fetchPriceHistory(14);
      // drops last (incomplete) candle
      expect(history.length).toBe(14);
      expect(typeof history[0]).toBe("number");
    });

    it("returns empty array on error", async () => {
      mockGet.mockRejectedValueOnce(new Error("network error"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const history = await fetchPriceHistory(14);
      expect(history).toEqual([]);
      warnSpy.mockRestore();
    });
  });
});
