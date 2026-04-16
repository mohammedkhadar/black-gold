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

  async _get<T>(path: string): Promise<T> {
    const res = await axios.get<T>(this.base + path, { headers: this.headers, timeout: 15000 });
    return res.data;
  }

  async _post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await axios.post<T>(this.base + path, body, { headers: this.headers, timeout: 15000 });
    return res.data;
  }
}
