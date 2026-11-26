# Strategy notes — pumpfun-bot-6h (6h PnL)

Base: the kit pilot sniper (`strategy.ts`), a launch sniper with a rug
filter — the same shared base as the 24h sibling entry, tuned differently
for a 6h final window. Tuning was done with the pilot's own `tools/grid.ts`
on the first 6h of the kit dev window (2 Nov 2026, 23,986 events), ranking
by net PnL with the ex-top-3-coins net and the coin count printed next to
every cell, and preferring flat regions over the single best cell. The final
window is recorded *after* the deadline, so no dev-window number is a
promise — breadth (enough coins to clear the guardrail) and a positive
expected value per trade are the point.

## Why this tuning, not the 24h one

- **The 6h window is thin.** The strict 24h filter (creator ≥0.7 SOL,
  ≥5 trades, real SOL ≥5 SOL) qualifies only 15 coins in the first 6h —
  below the 20-mint guardrail. Loosening to creator ≥0.5 SOL, ≥4 trades,
  real SOL ≥1 SOL qualifies 32–34 coins with net +0.067 SOL. The guardrail
  margin (32 vs 20) matters more than the last 0.01 SOL of dev net: an
  entry below 20 mints ranks below every entry that meets the bar.
- **Bigger stake (0.20 SOL vs 0.10 SOL).** In 6h there is no time to
  compound; a runner has to pay in one move. Stake 0.20 SOL lifts dev net
  from +0.050 to +0.067 SOL at the same coin count. The 1%-of-real-reserve
  cap binds first on small curves, so the effective buy is often smaller
  than the stake anyway.
- **Same exits as the 24h entry** (TP +25% / SL −20% / 10-slot max hold /
  out on creator sell): the TP/SL grid is flat on both windows, and these
  sit in the middle of the flat region. Partial take-profit and adds were
  tried on the 24h window and both cost net or robustness; they are off.
- **No order splitting** (maxSplit 1): pieces burn extra tx fees and crowd
  the 16-orders-per-batch cap. Disabling splits lifts 6h net from +0.058
  to +0.067 SOL.

## How the bot decides, per batch

The SDK shim sends a `hello` once (caps, fees, capital: 10 SOL paper),
then one `batch` per slot: the slot number, new chain events, fills of our
earlier orders, and marks for live curves. `onBatch` returns this batch's
orders (buys first as `quote_lamports`, sells as `token_amount`, each with
a slippage cap). Exits are decided before entries, so a slot never spends
cash it just freed on a coin it is leaving. No probe mechanism is needed:
the filter itself clears the guardrail (32 coins on dev).

## Guardrails

- ≥20 distinct mints with round trips ≥0.01 SOL: **32** on dev.
- Max drawdown ≤50%: **0.002** on dev.
- Max 5 open positions: the bot never holds more than 5 (1 buy per coin,
  no adds; the cap is enforced by the SDK's `committedPositionCount`).
- Deterministic: no clock, no randomness, no I/O, iteration only over
  insertion-ordered maps fed by the batch stream.

## Risks

- A 6h window holds ~30 qualifying launches on dev; the ranking is decided
  by whoever catches the biggest runner, and on dev the whole profit is
  essentially one coin (+0.048 of +0.067 SOL). The entry is a positive-EV
  lottery ticket, not a steady earner.
- If the final window is much quieter than dev, the coin count could fall
  toward the 20-mint guardrail. On dev the margin is 32 vs 20.
