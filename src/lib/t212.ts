import axios from "axios";
import { Buffer } from "node:buffer";
import type { CashInfo, Position, OrderResult, Instrument } from "./types.js";

const T212_BASE = "https://demo.trading212.com/api/v0";

export class Trading212Client {
  readonly mode = "PAPER";
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(apiKey: string, apiSecret: string) {
    if (!apiKey || !apiSecret) {
      throw new Error("T212_API_KEY and T212_SECRET_KEY must be set in .env or as GitHub Secrets.");
    }
    this.base = T212_BASE;
    const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
    this.headers = {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    };
  }

  async getCash(): Promise<CashInfo> {
    return this._get<CashInfo>("/equity/account/cash");
  }

  async getPosition(ticker: string): Promise<Position | null> {
    try {
      return await this._get<Position>(`/equity/portfolio/${ticker}`);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async placeMarketOrder(ticker: string, quantity: number): Promise<OrderResult> {
    return this._post<OrderResult>("/equity/orders/market", { ticker, quantity });
  }

  async searchInstruments(query: string): Promise<Instrument[]> {
    const all = await this._get<Instrument[]>("/equity/metadata/instruments");
    const q = query.toLowerCase();
    return all.filter(
      (i) => i.name?.toLowerCase().includes(q) || i.ticker?.toLowerCase().includes(q)
    );
  }

  private _logRateLimit(method: string, path: string, headers: Record<string, string>): void {
    const keys = [
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
      "retry-after",
      "x-retry-after",
    ];
    const found = keys.filter((k) => headers[k] !== undefined);
    if (found.length > 0) {
      const info = found.map((k) => `${k}: ${headers[k]}`).join("  |  ");
      console.log(`[T212 rate-limit] ${method} ${path}  →  ${info}`);
    } else {
      console.log(`[T212 rate-limit] ${method} ${path}  →  (no rate-limit headers found)`);
    }
  }

  private _retryDelay(headers: Record<string, string>): number {
    // Honour Retry-After if present (value in seconds)
    const ra = headers["retry-after"] ?? headers["x-retry-after"];
    if (ra) return Math.ceil(parseFloat(ra)) * 1000;
    // Fall back to reset timestamp
    const reset = headers["x-ratelimit-reset"];
    if (reset) {
      const ms = parseFloat(reset) * 1000 - Date.now();
      if (ms > 0 && ms < 60_000) return ms + 100;
    }
    return 1500; // safe default: 1.5 s
  }

  async _get<T>(path: string, attempt = 1): Promise<T> {
    try {
      const res = await axios.get<T>(this.base + path, { headers: this.headers, timeout: 15000 });
      this._logRateLimit("GET", path, res.headers as Record<string, string>);
      return res.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response) {
        this._logRateLimit("GET", path, err.response.headers as Record<string, string>);
        if (err.response.status === 429 && attempt <= 4) {
          const delay = this._retryDelay(err.response.headers as Record<string, string>);
          console.log(`[T212] GET ${path} rate-limited — retry ${attempt}/4 in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          return this._get<T>(path, attempt + 1);
        }
      }
      throw err;
    }
  }

  async _post<T>(path: string, body: Record<string, unknown>, attempt = 1): Promise<T> {
    try {
      const res = await axios.post<T>(this.base + path, body, { headers: this.headers, timeout: 15000 });
      this._logRateLimit("POST", path, res.headers as Record<string, string>);
      return res.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response) {
        this._logRateLimit("POST", path, err.response.headers as Record<string, string>);
        if (err.response.status === 429 && attempt <= 4) {
          const delay = this._retryDelay(err.response.headers as Record<string, string>);
          console.log(`[T212] POST ${path} rate-limited — retry ${attempt}/4 in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          return this._post<T>(path, body, attempt + 1);
        }
      }
      throw err;
    }
  }
}
