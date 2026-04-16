import readline from "node:readline";
import { C, col } from "./colors.js";
import type { Trading212Client } from "./t212.js";
import type { TelegramClient, OrderResult } from "./types.js";

export function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans); }));
}

export interface ExecuteSignalOpts {
  client: Trading212Client;
  signal: string;
  ticker: string;
  orderQty: number;
  autoConfirm: boolean;
  maxOrderQty: number;
  telegram: TelegramClient;
}

export async function executeSignal(opts: ExecuteSignalOpts): Promise<OrderResult | null> {
  const { client, ticker, autoConfirm, maxOrderQty, telegram } = opts;
  let { signal, orderQty } = opts;

  if (signal === "HOLD") {
    console.log("[INFO] Signal is HOLD — no order placed.");
    return null;
  }

  orderQty = Math.min(Math.max(1, Math.round(orderQty)), maxOrderQty);

  let position = null;
  try {
    position = await client.getPosition(ticker);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 401) {
      console.error("[ERROR] Authentication failed (401). Check your API key/secret.");
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] Failed to fetch position: ${msg}`);
    }
    return null;
  }

  if (signal === "SELL") {
    if (!position || parseFloat(position.quantity) <= 0) {
      console.log(`[INFO] SELL signal but no open position in ${ticker} — skipping.`);
      return null;
    }
  }

  const actionColor = signal === "BUY" ? C.green : C.red;
  const sellQty = signal === "SELL" ? Math.abs(parseFloat(position!.quantity)) : orderQty;
  console.log(`\n  ${C.bold}Proposed order${C.reset}`);
  console.log(`  Action  : ${col(actionColor, signal)}`);
  console.log(`  Ticker  : ${ticker}  (${client.mode})`);
  console.log(`  Quantity: ${sellQty} share(s)`);

  if (!autoConfirm) {
    const answer = await askQuestion(`\n  Confirm ${signal} order? [y/N]: `);
    if (answer.trim().toLowerCase() !== "y") {
      console.log("  Order cancelled by user.");
      return null;
    }
  }

  try {
    const qty = signal === "BUY" ? orderQty : -sellQty;
    const order = await client.placeMarketOrder(ticker, qty);
    const sigColor = signal === "BUY" ? C.green : C.red;
    console.log(`\n  ${col(sigColor, "Order submitted")}  id=${order.id ?? "?"}`);
    console.log(`[INFO] Order response: ${JSON.stringify(order, null, 2)}`);
    await telegram.send(
      `✅ <b>Order placed</b> — ${client.mode}\n` +
      `Ticker: <code>${ticker}</code>  qty: ${sellQty}\n` +
      `Order ID: <code>${order.id ?? "?"}</code>`
    );
    return order;
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    const msg = axiosErr.response?.data ? JSON.stringify(axiosErr.response.data) : (axiosErr.message ?? String(err));
    console.error(`[ERROR] Order failed [${axiosErr.response?.status}]: ${msg}`);
    await telegram.send(
      `❌ <b>Order failed</b> — ${client.mode}\n` +
      `Ticker: <code>${ticker}</code>  Signal: ${signal}\n` +
      `Error [${axiosErr.response?.status ?? "?"}]: ${msg.slice(0, 200)}`
    );
    return null;
  }
}

export async function cmdSearchInstruments(client: Trading212Client, query: string): Promise<void> {
  console.log(`\nSearching instruments for '${query}' …\n`);
  try {
    const results = await client.searchInstruments(query);
    if (!results.length) {
      console.log("  No matching instruments found.");
      return;
    }
    for (const inst of results.slice(0, 20)) {
      console.log(`  ${(inst.ticker ?? "?").padEnd(20)}  ${inst.name ?? "?"}`);
    }
    console.log();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] Could not fetch instruments: ${msg}`);
  }
}

export async function runLoop(runOnceFn: () => Promise<unknown>, intervalMinutes: number): Promise<never> {
  console.log(`Monitoring loop active — interval: ${intervalMinutes} min.  Ctrl+C to stop.\n`);
  while (true) {
    await runOnceFn();
    console.log(`[INFO] Next refresh in ${intervalMinutes} minutes …`);
    await new Promise((r) => setTimeout(r, intervalMinutes * 60 * 1000));
  }
}
