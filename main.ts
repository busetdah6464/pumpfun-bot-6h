// pumpfun-bot-6h: a launch sniper for the 6h pump.fun bot sprint.
// Entry for u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed (make.fun).
//
// How it runs: the grader starts `node main.ts`. The vendored SDK shim
// (vendor/agentfun-bot.ts, a byte-identical copy of the kit file) sends one
// hello first, then one batch per slot. Each batch carries the slot, the new
// chain events, the fills of our earlier orders, and the marks (current
// reserves) for every live curve. Our onBatch answers with this batch's
// orders (at most hello.caps.max_orders_per_batch), and the SDK turns them
// into wire orders with client ids. No clock, no randomness, no I/O: the
// same batches always produce the same orders, so the two graded runs
// agree byte for byte.
//
// Strategy (strategy.ts, the kit pilot sniper, tuned here): watch every
// coin from its CreateEvent and buy only launches that pass the rug filter
// in their first slots — the creator bought in size at creation, several
// real trades already printed, few distinct buyers (no Sybil bundle),
// creator has not sold, real SOL in a healthy band. Take profit fast,
// cut losers, never hold past maxHold slots, exit at once when the creator
// sells. See STRATEGY.md for the tuning numbers and why each knob is set
// the way it is.
//
// This is the 6-hour variant: the final window is only 6h, so the filter
// is looser than the 24h sibling (more coins qualify, to clear the
// 20-mint guardrail with margin) and the stake is bigger (0.20 SOL) so a
// runner pays more in the short window.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, type Params } from './strategy.ts';

// Tuned on the first 6h of the kit dev window (2 Nov 2026, 23,986 events)
// with the pilot's grid tool, preferring flat, robust regions over the
// single best cell:
//   net +0.067 SOL, 32 coins, 64 fills, max drawdown 0.002 — guardrails
//   (20+ coins, round trips >= 0.01 SOL, drawdown <= 50%) cleared.
const PARAMS: Partial<Params> = {
  // Entry: buy only in the first 10 slots after creation, once at least
  // 4 trades printed and the creator's own create-slot buy was >= 0.5 SOL.
  minAge: 0,
  maxAge: 10,
  minTrades: 4,
  minDevBuy: 500_000_000,
  maxDevBuy: 2_500_000_000,
  // At most 10 distinct non-creator buyers before entry: a launch bundled
  // by many wallets in its first slots is a dump waiting to happen.
  minBuyers: 0,
  maxBuyers: 10,
  // Only curves holding 1–30 SOL of real SOL at decision time. The floor
  // is low on purpose: in a 6h window few launches qualify, and the
  // 1%-of-real-reserve cap still keeps every buy >= 0.01 SOL.
  minRealSol: 1_000_000_000,
  maxRealSol: 30_000_000_000,
  // Size: 0.20 SOL per coin, one buy only (no adds, no order splitting —
  // splits only burn extra tx fees and crowd the 16-orders-per-batch cap).
  stakeLamports: 200_000_000,
  minBuyLamports: 5_000_000,
  maxAdds: 0,
  maxSplit: 1,
  baseSplit: 1,
  // Exits: +25% take profit, -20% stop, 10-slot max hold, out at once on a
  // creator sell. No partial take-profit (it cost net on the dev window).
  tpBps: 2500,
  slBps: 2000,
  tp1Bps: 1_000_000,
  maxHold: 10,
  exitOnDevSell: true,
  buySlippageBps: 10_000,
};

const strategy = createStrategy({ ...DEFAULT_PARAMS, ...PARAMS });

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
