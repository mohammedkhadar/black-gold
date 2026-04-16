import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchMarketData, fetchPriceHistory } from "../../src/brent/market.js";

vi.mock("axios");
import axios from "axios";
const mockGet = vi.mocked(axios.get);

describe("brent/market", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("fetchMarketData", () => {
    it("returns market data from Stooq CSV", async () => {
      const csvData = "Symbol,Date,Time,Open,High,Low,Close,Volume\ncb.f,2024-01-15,17:00:00,75.50,76.20,74.80,75.90,12345";
      mockGet.mockResolvedValueOnce({ data: csvData });
      const data = await fetchMarketData();
      expect(data).not.toBeNull();
      expect(data?.price).toBeCloseTo(75.90, 2);
      expect(data?.dayHigh).toBeCloseTo(76.20, 2);
      expect(data?.dayLow).toBeCloseTo(74.80, 2);
      expect(data?.currency).toBe("USD");
    });

    it("tries cl.f when cb.f stooq returns no price", async () => {
      const emptyData = "Symbol,Date\ncb.f,2024-01-15";
      const goodCsv = "Symbol,Date,Time,Open,High,Low,Close,Volume\ncl.f,2024-01-15,17:00:00,74.00,74.50,73.50,74.20,9999";
      mockGet
        .mockResolvedValueOnce({ data: emptyData })
        .mockResolvedValueOnce({ data: goodCsv });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const data = await fetchMarketData();
      expect(data?.price).toBeCloseTo(74.20, 2);
      warnSpy.mockRestore();
    });

    it("returns null when all sources fail", async () => {
      mockGet.mockRejectedValue(new Error("network error"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const data = await fetchMarketData();
      expect(data).toBeNull();
      warnSpy.mockRestore();
    });

    it("calculates changePct from open price", async () => {
      const csvData = "Symbol,Date,Time,Open,High,Low,Close,Volume\ncb.f,2024-01-15,17:00:00,74.00,76.20,73.80,75.48,12345";
      mockGet.mockResolvedValueOnce({ data: csvData });
      const data = await fetchMarketData();
      // (75.48 - 74.00) / 74.00 * 100 ≈ 2.0
      expect(data?.changePct).toBeCloseTo(2.0, 1);
    });
  });

  describe("fetchPriceHistory", () => {
    it("returns closing prices oldest-first", async () => {
      const csvLines = [
        "Date,Open,High,Low,Close,Volume",
        "2024-01-10,73.00,74.00,72.50,73.50,1000",
        "2024-01-11,73.50,75.00,73.00,74.20,1100",
        "2024-01-12,74.20,75.50,73.80,75.00,1200",
        "2024-01-13,75.00,76.00,74.50,75.80,1300",
        "2024-01-14,75.80,77.00,75.00,76.50,1400",
      ].join("\n");
      mockGet.mockResolvedValueOnce({ data: csvLines });
      const history = await fetchPriceHistory(5);
      expect(history.length).toBe(5);
      expect(history[0]).toBeCloseTo(73.50, 2); // oldest
      expect(history[4]).toBeCloseTo(76.50, 2); // newest
    });

    it("returns empty array on error", async () => {
      mockGet.mockRejectedValueOnce(new Error("failed"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const history = await fetchPriceHistory(14);
      expect(history).toEqual([]);
      warnSpy.mockRestore();
    });
  });
});
