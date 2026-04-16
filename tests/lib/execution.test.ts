import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeSignal } from "../../src/lib/execution.js";
import type { TelegramClient, Position } from "../../src/lib/types.js";

// Mock the Trading212Client
const mockGetPosition = vi.fn();
const mockPlaceMarketOrder = vi.fn();
const mockClient = {
  mode: "PAPER" as const,
  getCash: vi.fn(),
  getPosition: mockGetPosition,
  placeMarketOrder: mockPlaceMarketOrder,
  searchInstruments: vi.fn(),
  _get: vi.fn(),
  _post: vi.fn(),
};

const mockTelegram: TelegramClient = { send: vi.fn() };

const opts = {
  client: mockClient as unknown as import("../../src/lib/t212.js").Trading212Client,
  ticker: "IB1Tl_EQ",
  orderQty: 1,
  autoConfirm: true,
  maxOrderQty: 1000,
  telegram: mockTelegram,
};

describe("executeSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null and logs for HOLD signal", async () => {
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await executeSignal({ ...opts, signal: "HOLD" });
    expect(result).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("HOLD"));
    infoSpy.mockRestore();
  });

  it("skips SELL when no position exists", async () => {
    mockGetPosition.mockResolvedValueOnce(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await executeSignal({ ...opts, signal: "SELL" });
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("no open position"));
    logSpy.mockRestore();
  });

  it("skips SELL when position quantity is 0", async () => {
    const pos: Position = { quantity: "0", averagePrice: "50000", ppl: "0" };
    mockGetPosition.mockResolvedValueOnce(pos);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await executeSignal({ ...opts, signal: "SELL" });
    expect(result).toBeNull();
    logSpy.mockRestore();
  });

  it("places BUY order and sends Telegram notification", async () => {
    mockGetPosition.mockResolvedValueOnce(null); // no existing position
    mockPlaceMarketOrder.mockResolvedValueOnce({ id: "ord123" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await executeSignal({ ...opts, signal: "BUY" });

    expect(mockPlaceMarketOrder).toHaveBeenCalledWith("IB1Tl_EQ", 1);
    expect(result).toEqual({ id: "ord123" });
    expect(mockTelegram.send).toHaveBeenCalledWith(expect.stringContaining("Order placed"));
    logSpy.mockRestore();
  });

  it("places SELL order using position quantity", async () => {
    const pos: Position = { quantity: "5", averagePrice: "48000", ppl: "200" };
    mockGetPosition.mockResolvedValueOnce(pos);
    mockPlaceMarketOrder.mockResolvedValueOnce({ id: "ord456" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await executeSignal({ ...opts, signal: "SELL" });

    // SELL uses negative quantity of the held amount
    expect(mockPlaceMarketOrder).toHaveBeenCalledWith("IB1Tl_EQ", -5);
    expect(result).toEqual({ id: "ord456" });
    logSpy.mockRestore();
  });

  it("returns null and sends error Telegram on order failure", async () => {
    mockGetPosition.mockResolvedValueOnce(null);
    const axiosErr = Object.assign(new Error("Insufficient funds"), {
      response: { status: 422, data: { message: "Insufficient funds" } },
    });
    mockPlaceMarketOrder.mockRejectedValueOnce(axiosErr);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await executeSignal({ ...opts, signal: "BUY" });

    expect(result).toBeNull();
    expect(mockTelegram.send).toHaveBeenCalledWith(expect.stringContaining("Order failed"));
    errSpy.mockRestore();
  });

  it("returns null and logs error on getPosition auth failure", async () => {
    const authErr = Object.assign(new Error("Unauthorized"), { response: { status: 401 } });
    mockGetPosition.mockRejectedValueOnce(authErr);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await executeSignal({ ...opts, signal: "BUY" });

    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Authentication failed (401)"));
    errSpy.mockRestore();
  });

  it("caps orderQty at maxOrderQty", async () => {
    mockGetPosition.mockResolvedValueOnce(null);
    mockPlaceMarketOrder.mockResolvedValueOnce({ id: "ord789" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await executeSignal({ ...opts, signal: "BUY", orderQty: 9999, maxOrderQty: 1000 });

    expect(mockPlaceMarketOrder).toHaveBeenCalledWith("IB1Tl_EQ", 1000);
    logSpy.mockRestore();
  });
});
