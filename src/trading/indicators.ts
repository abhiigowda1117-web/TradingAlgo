import type { Candle } from '../types';

/** Exponential moving average, seeded with the SMA of the first `period` values. NaN until warmed up. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. NaN until `period + 1` values are available. */
export function rsi(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder's Average True Range. NaN until `period + 1` candles are available. */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Simple moving average. NaN until `period` values are available. */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Highest value of the `period` bars BEFORE bar i (bar i itself excluded), so "close above the
 * previous 55-day high" can be tested on bar i. NaN until `period` earlier bars exist.
 */
export function priorHighest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period; j < i; j++) m = Math.max(m, values[j]!);
    out[i] = m;
  }
  return out;
}

/** Lowest value of the `period` bars before bar i (bar i excluded). NaN until `period` earlier bars exist. */
export function priorLowest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period; j < i; j++) m = Math.min(m, values[j]!);
    out[i] = m;
  }
  return out;
}

/** Highest value of the `period` bars ending at bar i (bar i included). NaN until warmed up. */
export function highest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.max(m, values[j]!);
    out[i] = m;
  }
  return out;
}

/**
 * Supertrend (ATR bands around the bar midpoint). `value` is the active band: below price in an
 * uptrend (dir 1), above price in a downtrend (dir -1). NaN until the ATR is warmed up.
 */
export function supertrend(candles: Candle[], period: number, mult: number): { value: number[]; dir: number[] } {
  const a = atr(candles, period);
  const value = new Array<number>(candles.length).fill(NaN);
  const dir = new Array<number>(candles.length).fill(NaN);
  let upper = NaN;
  let lower = NaN;
  let trend = 1;
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(a[i]!)) continue;
    const c = candles[i]!;
    const mid = (c.high + c.low) / 2;
    const bu = mid + mult * a[i]!;
    const bl = mid - mult * a[i]!;
    const first = Number.isNaN(upper);
    const prevClose = i > 0 ? candles[i - 1]!.close : c.close;
    upper = first || bu < upper || prevClose > upper ? bu : upper;
    lower = first || bl > lower || prevClose < lower ? bl : lower;
    if (first) trend = c.close >= mid ? 1 : -1;
    else if (trend === 1 && c.close < lower) trend = -1;
    else if (trend === -1 && c.close > upper) trend = 1;
    value[i] = trend === 1 ? lower : upper;
    dir[i] = trend;
  }
  return { value, dir };
}
