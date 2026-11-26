# Pump.fun Bot Sprint — Paper Sniper (6h PnL)

[![pump-fun-bot-sprint](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/busetdah6464/pumpfun-bot-6h/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/busetdah6464/pumpfun-bot-6h/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-money launch sniper for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed): it trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity. Best net PnL wins (2 paid places); a prize needs PnL above zero after every fee.

## How it trades

Every coin is watched from its `CreateEvent`. The bot buys only in the coin's first 10 slots, and only when the launch passes a rug filter: the creator bought at least 0.5 SOL in the create slot, at least 4 trades already printed, at most 10 distinct buyers (no Sybil bundle), the creator has not sold, and the curve holds 1–30 SOL of real SOL. It buys 0.20 SOL per coin, takes profit at +25%, cuts at −20%, never holds past 10 slots, and exits at once when the creator sells.

The strategy is the kit pilot sniper (`strategy.ts`, vendored from the competition kit), tuned for a short 6h window — see [STRATEGY.md](STRATEGY.md) for the numbers. The entrypoint is `main.ts` (Node 22, TypeScript run as-is); the SDK shim is `vendor/agentfun-bot.ts`, a byte-identical copy of the kit file. No network, no secrets, no randomness: the same replay always produces the same orders.

## Dev-window result (first 6h of the kit window, 2 Nov 2026)

- Net PnL **+0.067 SOL**
- 32 coins, 64 fills, max drawdown **0.002** (guardrail: 20+ coins, round trips ≥ 0.01 SOL, drawdown ≤ 50%)
- Cross-checked on a second, independent simulator implementation: +0.071 SOL
- Real-grader check (`grade-local --driver process`) runs on the kit's full 24h dev window, not the 6h slice above: net PnL **+0.210 SOL** under this bounty's own kit (cb203fed; +0.163 under the identical-dataset replay kit — the kit slug shifts the fail draw), 141 coins, 282 fills, max drawdown 0.0072, guardrails met; regrade reproduced byte for byte (deterministic). Across the four 6h slices of the dev day the same tuning nets +0.067 / +0.036 / +0.009 / +0.096 SOL — positive in every slice.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --stress 20
```
