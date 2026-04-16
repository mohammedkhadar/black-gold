/** Shared domain types used across both bots. */

export interface NewsItem {
  title: string;
  source: string;
  pubDate: Date | null;
}

export interface MarketData {
  ticker: string;
  price: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  currency: string;
  prevClose?: number;
}

export interface MomentumResult {
  momentumScore: number;
  rsi: number | null;
}

export interface AIResult {
  aiSignal: string;
  aiScore: number;
  reasoning: string;
  aiAvailable: boolean;
}

export type Signal = "BUY" | "HOLD" | "SELL";

export interface SignalResult {
  signal: Signal;
  netScore: number;
  aiScore: number;
  momentumScore: number;
  rsi: number | null;
  newsHash: string;
  reasoning: string;
}

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  append(listKey: string, value: string): Promise<void>;
}

export interface TelegramClient {
  send(text: string): Promise<void>;
}

export interface OrderResult {
  id?: string;
  [key: string]: unknown;
}

export interface Position {
  quantity: string;
  averagePrice: string;
  ppl: string;
}

export interface CashInfo {
  free: number;
  invested: number;
  total: number;
  result: number;
}

export interface Instrument {
  ticker: string;
  name: string;
  [key: string]: unknown;
}

export interface AIBlend {
  ai: number;
  momentum: number;
}
