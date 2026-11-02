import type { Candle } from '../types';
import { affordableValue, tradeCosts, type CostSchedule } from './costs';
import { dayKey } from './portfolioBacktest';

export type BenchmarkKind = 'PRICE' | 'TRI';

export interface AlignedBenchmark {
  /** Benchmark close for each calendar day. */
  values: number[];
  /** Calendar days with no benchmark value, filled with the previous close. */
  filledDays: string[];
}

/**
 * Puts benchmark closes on the strategy's trading calendar. Missing days are filled with the
 * previous close (and counted); a benchmark that does not start by the first calendar day, or
 * that is missing more than `maxFillPct` of days, is rejected rather than silently patched.
 */
export function alignBenchmark(calendar: string[], series: Candle[], maxFillPct = 0.02): AlignedBenchmark {
  if (calendar.length === 0) throw new Error('Empty calendar');
  const byDay = new Map(series.map((c) => [dayKey(c.time), c.close]));
  const sorted = [...byDay.keys()].sort();
  let prev = [...sorted].reverse().find((k) => k <= calendar[0]!);
  if (prev === undefined) throw new Error(`Benchmark has no data on or before ${calendar[0]} (starts ${sorted[0] ?? 'never'})`);
  let last = byDay.get(prev)!;
  const values: number[] = [];
  const filledDays: string[] = [];
  for (const day of calendar) {
    const v = byDay.get(day);
    if (v !== undefined && Number.isFinite(v) && v > 0) last = v;
    else filledDays.push(day);
    values.push(last);
  }
  if (filledDays.length / calendar.length > maxFillPct) {
    throw new Error(`Benchmark is missing ${filledDays.length} of ${calendar.length} trading days (more than ${(maxFillPct * 100).toFixed(0)}%); check the data source`);
  }
  return { values, filledDays };
}

export interface BuyAndHoldResult {
  curve: { day: string; equity: number }[];
  units: number;
  buyCosts: number;
  sellCosts: number;
  /** Value after selling at the final close, net of slippage and selling costs. */
  liquidationValue: number;
}

/**
 * Invests the whole capital at the first day's close (fractional units, as through an index fund
 * or ETF), applying the same slippage and cost schedule as the strategy, and holds to the end.
 */
export function buyAndHold(calendar: string[], values: number[], capital: number, costs: CostSchedule, slippagePct: number): BuyAndHoldResult {
  const buyPrice = values[0]! * (1 + slippagePct);
  const invested = affordableValue(capital, costs);
  const buyCosts = tradeCosts('BUY', invested, costs).total;
  const units = invested / buyPrice;
  const leftover = capital - invested - buyCosts;
  const curve = calendar.map((day, i) => ({ day, equity: leftover + units * values[i]! }));
  const sellValue = units * values.at(-1)! * (1 - slippagePct);
  const sellCosts = tradeCosts('SELL', sellValue, costs).total;
  return { curve, units, buyCosts, sellCosts, liquidationValue: leftover + sellValue - sellCosts };
}
