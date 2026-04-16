import axios from "axios";
import { Buffer } from "node:buffer";

const T212_BASE = "https://demo.trading212.com/api/v0";

export class Trading212Client {
  constructor(apiKey, apiSecret) {
    if (!apiKey || !apiSecret) {
      throw new Error("T212_API_KEY and T212_SECRET_KEY must be set in .env or as GitHub Secrets.");
    }
    this.base = T212_BASE;
    this.mode = "PAPER";
    const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
    this.headers = {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    };
  }

  async getCash() {
    return this._get("/equity/account/cash");
  }

  async getPosition(ticker) {
    try {
      return await this._get(`/equity/portfolio/${ticker}`);
    } catch (err) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  async placeMarketOrder(ticker, quantity) {
    return this._post("/equity/orders/market", { ticker, quantity });
  }

  async searchInstruments(query) {
    const all = await this._get("/equity/metadata/instruments");
    const q = query.toLowerCase();
    return all.filter(
      (i) => i.name?.toLowerCase().includes(q) || i.ticker?.toLowerCase().includes(q)
    );
  }

  async _get(path) {
    const res = await axios.get(this.base + path, { headers: this.headers, timeout: 15000 });
    return res.data;
  }

  async _post(path, body) {
    const res = await axios.post(this.base + path, body, { headers: this.headers, timeout: 15000 });
    return res.data;
  }
}
