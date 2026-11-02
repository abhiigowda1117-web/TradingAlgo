import { atr, ema, rsi } from '../trading/indicators';
import type { Candle } from './types';

/** MACD line (fast EMA − slow EMA), its signal EMA and the histogram. NaN until warmed up. */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => f[i]! - s[i]!);
  const firstValid = line.findIndex((v) => !Number.isNaN(v));
  const sig = new Array<number>(closes.length).fill(NaN);
  if (firstValid >= 0) {
    const tail = ema(line.slice(firstValid), signal);
    tail.forEach((v, i) => (sig[firstValid + i] = v));
  }
  return { line, signal: sig, histogram: line.map((v, i) => v - sig[i]!) };
}

export interface Level {
  price: number;
  touches: number;
}

/**
 * Support/resistance from swing points: a bar whose high (low) is the highest (lowest) of the
 * `window` bars on each side. Nearby swings (within `tolerance`) are merged; more touches = more
 * significant. Supports are below the last close, resistances above it.
 */
export function supportResistance(candles: Candle[], window = 5, tolerance = 0.015, lookback = 250) {
  const c = candles.slice(-lookback);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = window; i < c.length - window; i++) {
    const around = c.slice(i - window, i + window + 1);
    if (c[i]!.high === Math.max(...around.map((x) => x.high))) highs.push(c[i]!.high);
    if (c[i]!.low === Math.min(...around.map((x) => x.low))) lows.push(c[i]!.low);
  }
  const cluster = (points: number[]): Level[] => {
    const levels: { sum: number; n: number }[] = [];
    for (const p of [...points].sort((a, b) => a - b)) {
      const last = levels.at(-1);
      if (last && Math.abs(p / (last.sum / last.n) - 1) <= tolerance) {
        last.sum += p;
        last.n++;
      } else levels.push({ sum: p, n: 1 });
    }
    return levels.map((l) => ({ price: l.sum / l.n, touches: l.n }));
  };
  const close = c.at(-1)?.close ?? NaN;
  const all = cluster([...highs, ...lows]);
  return {
    supports: all.filter((l) => l.price < close).sort((a, b) => b.price - a.price).slice(0, 3),
    resistances: all.filter((l) => l.price > close).sort((a, b) => a.price - b.price).slice(0, 3),
  };
}

export type Trend = 'Uptrend' | 'Downtrend' | 'Sideways / mixed' | 'Not Available';

/** Uptrend: close > EMA50 > EMA200 with EMA200 rising over 20 sessions. Downtrend: the mirror. Otherwise mixed. */
export function classifyTrend(close: number, e50: number, e200: number, e200Prev: number): { trend: Trend; reason: string } {
  if ([close, e50, e200, e200Prev].some((x) => !Number.isFinite(x))) return { trend: 'Not Available', reason: 'Not enough price history for EMA 200' };
  const rising = e200 > e200Prev;
  if (close > e50 && e50 > e200 && rising) return { trend: 'Uptrend', reason: 'Price above EMA 50, EMA 50 above EMA 200, EMA 200 rising' };
  if (close < e50 && e50 < e200 && !rising) return { trend: 'Downtrend', reason: 'Price below EMA 50, EMA 50 below EMA 200, EMA 200 falling' };
  return { trend: 'Sideways / mixed', reason: 'Price and averages do not line up in one direction' };
}

const val = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? null : x);

export interface TechnicalSection {
  lastClose: number | null;
  lastDate: string | null;
  dataNote: string;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: { line: number | null; signal: number | null; histogram: number | null; state: string };
  atr14: number | null;
  volume: { avg20: number | null; avg50: number | null; ratio: number | null; trend: string };
  high52: number | null;
  low52: number | null;
  returns: { label: string; value: number | null }[];
  trend: { trend: Trend; reason: string };
  supports: Level[];
  resistances: Level[];
  /** Last ~250 sessions for charts. */
  series: { date: string; close: number; volume: number; ema20: number | null; ema50: number | null; ema200: number | null; macd: number | null; signal: number | null }[];
}

export function analyzeTechnicals(candles: Candle[]): TechnicalSection {
  const closes = candles.map((c) => c.close);
  const n = candles.length;
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const a = atr(candles, 14);
  const avg = (k: number) => (n >= k ? candles.slice(-k).reduce((s, c) => s + c.volume, 0) / k : null);
  const avg20 = avg(20);
  const avg50 = avg(50);
  const vr = avg20 !== null && avg50 ? avg20 / avg50 : null;
  const year = candles.slice(-252);
  const ret = (k: number) => (n > k ? closes[n - 1]! / closes[n - 1 - k]! - 1 : null);
  const last = n - 1;
  const h = m.histogram[last];
  const sr = n > 20 ? supportResistance(candles) : { supports: [], resistances: [] };
  return {
    lastClose: val(closes[last]),
    lastDate: n ? candles[last]!.time.toISOString().slice(0, 10) : null,
    dataNote: 'Daily candles from Yahoo Finance; end-of-day or delayed, not real-time.',
    ema20: val(e20[last]),
    ema50: val(e50[last]),
    ema200: val(e200[last]),
    rsi14: val(r[last]),
    macd: {
      line: val(m.line[last]),
      signal: val(m.signal[last]),
      histogram: val(h),
      state: h === undefined || !Number.isFinite(h) ? 'Not Available' : h > 0 ? 'MACD above signal (bullish momentum)' : 'MACD below signal (bearish momentum)',
    },
    atr14: val(a[last]),
    volume: { avg20, avg50, ratio: vr, trend: vr === null ? 'Not Available' : vr > 1.2 ? 'Rising (20-day average > 1.2× 50-day)' : vr < 0.8 ? 'Falling (20-day average < 0.8× 50-day)' : 'Stable' },
    high52: year.length ? Math.max(...year.map((c) => c.high)) : null,
    low52: year.length ? Math.min(...year.map((c) => c.low)) : null,
    returns: [
      { label: '1 month', value: ret(21) },
      { label: '3 months', value: ret(63) },
      { label: '6 months', value: ret(126) },
      { label: '1 year', value: ret(252) },
    ],
    trend: classifyTrend(closes[last] ?? NaN, e50[last] ?? NaN, e200[last] ?? NaN, e200[last - 20] ?? NaN),
    supports: sr.supports,
    resistances: sr.resistances,
    series: candles.slice(-250).map((c, i, arr) => {
      const j = n - arr.length + i;
      return { date: c.time.toISOString().slice(0, 10), close: c.close, volume: c.volume, ema20: val(e20[j]), ema50: val(e50[j]), ema200: val(e200[j]), macd: val(m.line[j]), signal: val(m.signal[j]) };
    }),
  };
}
