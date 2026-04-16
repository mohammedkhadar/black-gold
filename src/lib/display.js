import { C, col } from "./colors.js";

export async function printAccountInfo(client) {
  try {
    const cash = await client.getCash();
    console.log(`  ${C.bold}Trading 212 Account (${client.mode})${C.reset}`);
    console.log(`  Free cash : ${cash.free}`);
    console.log(`  Invested  : ${cash.invested}`);
    console.log(`  Total     : ${cash.total}`);
    console.log(`  P&L       : ${cash.result}\n`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) {
      console.warn("  [WARN] Account info requires 'Read account' permission.\n");
    } else {
      console.warn(`  [WARN] Could not fetch account info: ${err.message}\n`);
    }
  }
}

export async function printPositionInfo(client, ticker) {
  try {
    const pos = await client.getPosition(ticker);
    if (pos) {
      console.log(`  ${C.bold}Current position in ${ticker}${C.reset}`);
      console.log(`  Quantity       : ${pos.quantity}`);
      console.log(`  Avg price      : ${pos.averagePrice}`);
      console.log(`  Unrealised P&L : ${pos.ppl}\n`);
    } else {
      console.log(`  No open position in ${ticker}.\n`);
    }
  } catch (err) {
    console.warn(`  [WARN] Could not fetch position for ${ticker}: ${err.message}\n`);
  }
}

export function printSignal(signal, netScore) {
  const sigColor = signal === "BUY" ? C.green : signal === "SELL" ? C.red : C.yellow;
  console.log(`  ${C.bold}Signal    : ${col(sigColor, signal)}${col(C.dim, " (via Nemotron-3-Super-120B)")}${C.reset}`);
  console.log(`  Net score : ${netScore >= 0 ? "+" : ""}${netScore}\n`);
}

export function printTopItems(items, topN = 75) {
  const top = items.slice(0, topN);
  if (!top.length) {
    console.log("  No headlines found.\n");
    return;
  }
  console.log(`  ${C.bold}Latest headlines:${C.reset}`);
  for (let i = 0; i < top.length; i++) {
    console.log(`  ${String(i + 1).padStart(2)}. ${top[i].title.slice(0, 80)}`);
    console.log(`       ${C.dim}${top[i].source}${C.reset}\n`);
  }
}

export function printDisclaimer(note = "Trading involves substantial risk of loss.") {
  console.log(`\n${C.dim}${"─".repeat(65)}`);
  console.log("  Signals are informational. This is not financial advice.");
  console.log(`  ${note}${C.reset}`);
  console.log(`${C.dim}${"─".repeat(65)}${C.reset}\n`);
}
