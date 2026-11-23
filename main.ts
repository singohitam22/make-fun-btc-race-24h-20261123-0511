// btc-race-24h-20261123-0511: a long-only trend-following bot for cbBTC/USDC
// on 1-minute bars (agent-fun/bars-replay/v1).
//
// Strategy (written from scratch for this competition):
//   * EMA crossover (fast 8 / slow 21 on 1-minute closes) defines the trend.
//   * Entry only when the trend is confirmed twice: the trailing 15-bar
//     return must clear +15 bps, and the close must sit above the 240-bar
//     EMA (regime filter), so dead-cat bounces in a downtrend are skipped.
//   * Exit on a trailing stop 2.20% below the position peak, or a hard stop
//     1.20% below the entry price. No exit on EMA cross-down: on 1-minute
//     bars the cross whipsaws and each re-entry pays ~26 bps. No
//     take-profit cap: the trailing stop lets a real rally run.
//   * Full-size entries (100% of equity) while flat, one position at a time.
//   * A short cooldown after every exit, and no new entries in the final
//     stretch of the window (the harness flattens everything at the end,
//     which costs fees, so a late entry cannot pay for itself).
//
// Determinism: no network, no wall clock, no file reads, no Math.random.
// Every decision is a pure function of the bars and fills seen so far.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// ---- tunable strategy parameters (single place, so variants are cheap) ----
const FAST_PERIOD = 8; // fast EMA length, bars
const SLOW_PERIOD = 21; // slow EMA length, bars
const REGIME_PERIOD = 240; // long EMA: entries only above it (regime filter)
const MOM_BARS = 15; // trailing window for the momentum filter, bars
const MOM_MIN_BPS = 15; // entry needs a 15-bar return above this, in bps
const EMA_SPREAD_MIN_BPS = 3; // entry needs fast EMA above slow by this, bps
const TRAIL_STOP_BPS = 220; // exit when close falls this far below the peak, bps
const HARD_STOP_BPS = 120; // exit when close falls this far below entry, bps
const COOLDOWN_BARS = 5; // bars to wait after an exit before re-entering
const NO_ENTRY_TAIL_BARS = 30; // do not open in the last N bars of the window
const MAX_SLIPPAGE_BPS = 50; // per-order slippage allowance vs latest close
const DD_GUARD_BPS = 2000; // emergency flatten if equity falls 20% off its peak

const BPS = 10_000;

// ---- per-run state (all derived from the bar/fill stream, nothing else) ----
let closes: number[] = []; // closes in USDC, oldest first
let emaFast: number | null = null;
let emaSlow: number | null = null;
let emaLong: number | null = null;
let barsSeen = 0;
let entryPrice = 0; // USDC price the current position was filled at
let peakPrice = 0; // highest close since entry
let lastExitBar = -1_000_000; // bar index of the most recent exit fill
let equityPeak = 0n; // highest equity (micro-USDC) seen so far
let inPosition = false;

function emaUpdate(prev: number | null, price: number, period: number): number {
  if (prev === null) return price;
  const k = 2 / (period + 1);
  return price * k + prev * (1 - k);
}

/** Trailing return over MOM_BARS bars, in bps; null until enough history. */
function momentumBps(): number | null {
  if (closes.length <= MOM_BARS) return null;
  const old = closes[closes.length - 1 - MOM_BARS];
  const now = closes[closes.length - 1];
  if (old <= 0) return null;
  return ((now / old - 1) * BPS);
}

/** Fold the fills of this batch into position bookkeeping. */
function applyFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
    const price = Number(fill.price) / 100_000; // price_scale 5
    if (fill.side === 'buy') {
      entryPrice = price;
      peakPrice = price;
      inPosition = true;
    } else {
      inPosition = false;
      entryPrice = 0;
      peakPrice = 0;
      lastExitBar = barsSeen;
    }
  }
}

// ---- decision logic: exactly one reply per batch, at most one order ----

function decide(state: BarsState, batch: Batch) {
  applyFills(batch);

  const bar = state.latest.get(SYMBOL);
  if (bar === undefined) return [];
  const close = Number(bar.c) / 100_000; // price_scale 5 -> USDC
  closes.push(close);
  if (closes.length > 400) closes.splice(0, closes.length - 400);
  emaFast = emaUpdate(emaFast, close, FAST_PERIOD);
  emaSlow = emaUpdate(emaSlow, close, SLOW_PERIOD);
  emaLong = emaUpdate(emaLong, close, REGIME_PERIOD);
  barsSeen += 1;

  // Equity drawdown guard: flatten everything if we are deep underwater.
  if (state.equity > equityPeak) equityPeak = state.equity;
  const ddBps = equityPeak > 0n
    ? Number(((equityPeak - state.equity) * BigInt(BPS)) / equityPeak)
    : 0;
  const held = state.positions.get(SYMBOL);
  const heldQty = held?.qty ?? 0n;

  if (inPosition && heldQty > 0n) {
    if (close > peakPrice) peakPrice = close;
    // No exit on EMA cross-down: on 1-minute bars the cross whipsaws and
    // each re-entry pays ~26 bps. The trailing stop alone banks the trend
    // while capping how much of it is given back.
    const trailHit = peakPrice > 0 && close < peakPrice * (1 - TRAIL_STOP_BPS / BPS);
    const hardStop = entryPrice > 0 && close < entryPrice * (1 - HARD_STOP_BPS / BPS);
    const ddHit = ddBps >= DD_GUARD_BPS;
    if (trailHit || hardStop || ddHit) {
      return [{
        side: 'sell' as const,
        symbol: SYMBOL,
        qty: heldQty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      }];
    }
    return [];
  }

  // Flat: look for an entry. Need a warm trend, confirmed momentum, and
  // enough window left for the trade to pay its round-trip cost (~26 bps).
  if (state.warmingUp) return [];
  if (barsSeen - lastExitBar < COOLDOWN_BARS) return [];
  if (closes.length <= MOM_BARS) return [];
  if (emaFast === null || emaSlow === null) return [];
  const mom = momentumBps();
  if (mom === null || mom < MOM_MIN_BPS) return [];
  if (emaFast <= emaSlow) return [];
  if ((emaFast / emaSlow - 1) * BPS < EMA_SPREAD_MIN_BPS) return [];
  if (close < emaSlow) return [];
  // Regime filter: only trade longs while the 4-hour trend is up. In a
  // downtrend, momentum bursts are usually dead-cat bounces; skipping them
  // is what keeps the downside small when the window trends down.
  if (emaLong === null || close < emaLong) return [];

  // No-entry tail: the harness rejects orders on the last batch anyway, and
  // a position opened in the final bars is flattened at a fee with no time
  // to earn. Estimate the remaining bars from the batch count seen so far
  // only via the known window length (1440 bars); stop 30 bars early.
  // We cannot know the total from hello, so use the bar clock: the window
  // is 1440 bars and the first close is hello.first_close_ms.
  const elapsedBars = Math.round((batch.t - state.hello.first_close_ms) / 60_000) + 1;
  if (elapsedBars > 1440 - NO_ENTRY_TAIL_BARS) return [];

  const cash = state.cash;
  if (cash <= 0n) return [];
  return [{
    side: 'buy' as const,
    symbol: SYMBOL,
    notional_quote_units: cash,
    max_slippage_bps: MAX_SLIPPAGE_BPS,
  }];
}

await runBars({
  onBatch(state, batch) {
    return decide(state, batch);
  },
});
