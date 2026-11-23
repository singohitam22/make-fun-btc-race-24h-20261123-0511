[![Competition](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/singohitam22/make-fun-btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/singohitam22/make-fun-btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

# BTC Race Bot — cbBTC/USDC trend follower

A long-only trading bot for the [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511) competition on make.fun. It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute bars from the Orca Whirlpool, starting with $1,000 of paper money, speaking the `agent-fun/bars-replay/v1` protocol (NDJSON on stdin/stdout).

## Strategy

Trend-following, written from scratch for this competition:

- **Trend:** EMA crossover, fast 8 vs slow 21 on 1-minute closes.
- **Confirmation (both required):** the trailing 15-bar return must clear +15 bps, and the close must sit above the 240-bar EMA (regime filter) — so flat chop and dead-cat bounces in a downtrend are skipped. A round trip costs about 26 bps in fees, slippage and price impact, so a trade has to catch a real move.
- **Entry:** full size (100% of equity), one position at a time, only while flat.
- **Exit:** whichever comes first — a trailing stop 2.20% below the position peak, or a hard stop 1.20% below the entry price. No exit on EMA cross-down: on 1-minute bars the cross whipsaws and each re-entry pays ~26 bps. No take-profit cap: the trailing stop lets a real rally run while banking most of it.
- **Discipline:** a short cooldown after every exit, no new entries in the final 30 bars (the harness flattens everything at the end, which costs fees), and an emergency flatten if equity falls 20% off its peak (guardrail is 25% max drawdown).

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only).
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte-for-byte (vendored, excluded from authorship).
- `LICENSE` — MIT.

## Run

```sh
node main.ts
```

It reads NDJSON (`hello`, then one `batch` per minute, then `done`) on stdin and writes exactly one `reply` per batch on stdout. Deterministic: no network, no wall clock, no files outside the repo, no `Math.random` — two runs on the same data produce identical action logs.

## Local dev grade

Graded with the kit's own command (`node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process`):

- Net PnL: **+$32.47** on the dev window (gate needs > $0)
- Trades: 1, win rate 100%, max drawdown 1.98%, 0 rejected orders
- Determinism: L1 regrade reproduced byte for byte
