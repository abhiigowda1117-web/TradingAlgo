/**
 * Chart indicators. Every function returns one value per input bar (null where the indicator is not yet
 * defined), so results line up with the candles by index. Standard textbook definitions.
 */

export interface Bar {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Series = (number | null)[];

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
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

/** Bollinger Bands: SMA ± mult × population standard deviation. */
export function bollinger(values: number[], period = 20, mult = 2): { mid: Series; upper: Series; lower: Series } {
  const mid = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i]!;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j]! - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

/** RSI with Wilder's smoothing. */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
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

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): { macd: Series; signal: Series; hist: Series } {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] === null || s[i] === null ? null : f[i]! - s[i]!));
  const start = line.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  if (start >= 0) {
    const sig = ema(line.slice(start) as number[], signalPeriod);
    sig.forEach((v, j) => (signal[start + j] = v));
  }
  const hist: Series = line.map((v, i) => (v === null || signal[i] === null ? null : v - signal[i]!));
  return { macd: line, signal, hist };
}

/** Intraday VWAP from typical price, reset at the start of each day (times are IST-shifted Unix seconds). */
export function vwap(bars: Bar[]): Series {
  let day = -1;
  let pv = 0;
  let vol = 0;
  return bars.map((b) => {
    const d = typeof b.time === 'number' ? Math.floor(b.time / 86_400) : -2;
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
    return vol > 0 ? pv / vol : null;
  });
}

export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  bars.forEach((b, i) => {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1]!.open + out[i - 1]!.close) / 2;
    out.push({ time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), volume: b.volume });
  });
  return out;
}

/** Average true range with Wilder's smoothing. */
export function atr(bars: Bar[], period = 14): Series {
  const out: Series = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1]!.close), Math.abs(b.low - bars[i - 1]!.close))));
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Supertrend: value per bar plus direction (1 = uptrend, line below price; -1 = downtrend, line above). */
export function supertrend(bars: Bar[], period = 10, mult = 3): { value: Series; dir: (1 | -1 | null)[] } {
  const a = atr(bars, period);
  const value: Series = new Array(bars.length).fill(null);
  const dir: (1 | -1 | null)[] = new Array(bars.length).fill(null);
  let upper = 0;
  let lower = 0;
  let trend: 1 | -1 = 1;
  for (let i = 0; i < bars.length; i++) {
    if (a[i] === null) continue;
    const b = bars[i]!;
    const mid = (b.high + b.low) / 2;
    const bu = mid + mult * a[i]!;
    const bl = mid - mult * a[i]!;
    const first = i === 0 || value[i - 1] === null;
    const prevClose = i > 0 ? bars[i - 1]!.close : b.close;
    upper = first || bu < upper || prevClose > upper ? bu : upper;
    lower = first || bl > lower || prevClose < lower ? bl : lower;
    if (!first) {
      if (trend === 1 && b.close < lower) trend = -1;
      else if (trend === -1 && b.close > upper) trend = 1;
    } else trend = b.close >= mid ? 1 : -1;
    value[i] = trend === 1 ? lower : upper;
    dir[i] = trend;
  }
  return { value, dir };
}
