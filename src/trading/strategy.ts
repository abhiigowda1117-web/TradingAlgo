import type { StrategyConfig } from '../config';
import type { Candle } from '../types';
import { atr, ema, lowest, rsi } from './indicators';
import { DEFAULT_STRATEGY, isStrategyName, STRATEGY_IDS, type StrategyName } from './strategyIds';

/**
 * The daily (holding) strategy, from the owner's strategy document: "EMA 5/48 + RSI + MACD".
 * Long-only on daily candles, evaluated at a bar's close: delivery (CNC) shares cannot be sold short
 * overnight in India, so its SELL signal closes holdings. The intraday strategies (Fibonacci + 20 EMA,
 * Camarilla pivots, 9:30 opening range) are in trading/intraday.ts. Position sizing, risk limits,
 * stop-loss orders and the kill switch are applied by the engine.
 */

export { STRATEGY_IDS, type StrategyName };

/** Common indicators (the company study shows them); the strategy adds its own. */
export interface Indicators {
  fast: number[];
  slow: number[];
  trend: number[];
  rsi: number[];
  atr: number[];
  [extra: string]: number[];
}

export type EntryDecision = { enter: true; stop: number; reason: string } | { enter: false; reason: string };

export interface OpenTrade {
  stop: number;
  highestClose: number;
  /** Average buy price and the first stop, for the 1:2 target. */
  entryPrice?: number;
  initialStop?: number;
}

export type ExitDecision = { exit: true; reason: string } | { exit: false; stop: number; highestClose: number };

export interface StrategyInfo {
  id: StrategyName;
  name: string;
  style: string;
  summary: string;
  buy: string;
  sell: string;
  suits: string;
  inspiredBy?: string;
  source?: string;
}

interface StrategyDef extends StrategyInfo {
  warmup(cfg: StrategyConfig): number;
  extras(candles: Candle[], cfg: StrategyConfig): Record<string, number[]>;
  entry(c: Candle[], ind: Indicators, i: number, cfg: StrategyConfig): EntryDecision;
  exit(c: Candle[], ind: Indicators, i: number, t: OpenTrade, cfg: StrategyConfig): ExitDecision;
}

const nan = (...v: number[]) => v.some((x) => x === undefined || Number.isNaN(x));
const notReady: EntryDecision = { enter: false, reason: 'indicators not ready' };

/** MACD(12, 26, 9): line = EMA12 − EMA26, signal = EMA9 of the line. */
export function macdLines(closes: number[]): { macd: number[]; signal: number[] } {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macd = closes.map((_, i) => e12[i]! - e26[i]!);
  const first = macd.findIndex((x) => !Number.isNaN(x));
  const signal = new Array<number>(closes.length).fill(NaN);
  if (first >= 0) ema(macd.slice(first), 9).forEach((v, k) => (signal[first + k] = v));
  return { macd, signal };
}

/** Risk-reward of the target: 1:2, the document's preferred target. */
export const TARGET_R = 2;
/** Stop below the lowest low of the last 5 sessions ("below the recent lowest price"), at least 0.5% away. */
const SWING_BARS = 5;

const DEFS: Record<StrategyName, StrategyDef> = {
  ema548: {
    id: 'ema548',
    name: 'EMA 5/48 + RSI + MACD',
    style: 'Trend following (daily, holds shares)',
    summary: 'From your strategy document: EMA 5/48 shows the trend, RSI the buying strength and MACD confirms the momentum. Buys after a small dip in an uptrend once a green candle confirms; sells at a 1:2 target, at the stop-loss, or when the trend or strength turns.',
    buy: 'All of: EMA 5 above EMA 48; the close above both EMAs; a slight dip in the last 3 sessions (a low at or below EMA 5); RSI(14) above 50; MACD line above its signal line; and a green candle (close above open) to confirm. Stop-loss below the lowest low of the last 5 sessions.',
    sell: 'The first of: the 1:2 target (entry + 2 × the risk per share); the stop-loss; the trend changes (EMA 5 below EMA 48); or the buying strength becomes weak (RSI below 50, or MACD crosses below its signal line).',
    suits: 'Stocks in clear uptrends. In sideways markets the EMAs cross often and give small losses.',
    inspiredBy: 'Your strategy document (EMA 5/48 + RSI + MACD)',
    source: 'algo_trade_stratergy_stocks.docx, sections 1-11. Short selling (the SELL setup) is not possible with delivery shares; here the SELL signal closes holdings, and short trades are made by the intraday strategies.',
    warmup: () => 56,
    extras(c) {
      const closes = c.map((x) => x.close);
      const { macd, signal } = macdLines(closes);
      return { ema5: ema(closes, 5), ema48: ema(closes, 48), macd, macdSignal: signal, swingLow: lowest(c.map((x) => x.low), SWING_BARS) };
    },
    entry(c, ind, i) {
      if (i < 3) return notReady;
      const bar = c[i]!;
      const [e5, e48, r, m, s, lo] = [ind.ema5![i]!, ind.ema48![i]!, ind.rsi[i]!, ind.macd![i]!, ind.macdSignal![i]!, ind.swingLow![i]!];
      if (nan(e5, e48, r, m, s, lo)) return notReady;
      if (!(e5 > e48)) return { enter: false, reason: 'EMA 5 not above EMA 48' };
      if (!(bar.close > e5 && bar.close > e48)) return { enter: false, reason: 'price not above both EMAs' };
      const dipped = [1, 2, 3].some((k) => !Number.isNaN(ind.ema5![i - k]!) && c[i - k]!.low <= ind.ema5![i - k]!);
      if (!dipped) return { enter: false, reason: 'no small dip yet (waiting for the price to come down slightly)' };
      if (!(r > 50)) return { enter: false, reason: `RSI ${r.toFixed(0)} not above 50` };
      if (!(m > s)) return { enter: false, reason: 'MACD not bullish' };
      if (!(bar.close > bar.open)) return { enter: false, reason: 'no green confirmation candle' };
      const stop = Math.min(lo * 0.999, bar.close * 0.995);
      return { enter: true, stop, reason: `EMA 5 > EMA 48, dip bought, RSI ${r.toFixed(0)}, MACD bullish, green candle; target 1:${TARGET_R}` };
    },
    exit(c, ind, i, t) {
      const close = c[i]!.close;
      const highestClose = Math.max(t.highestClose, close);
      const risk = t.entryPrice !== undefined && t.initialStop !== undefined ? t.entryPrice - t.initialStop : NaN;
      if (risk > 0 && close >= t.entryPrice! + TARGET_R * risk) return { exit: true, reason: `target 1:${TARGET_R} reached` };
      const [e5, e48, r, m, s] = [ind.ema5![i]!, ind.ema48![i]!, ind.rsi[i]!, ind.macd![i]!, ind.macdSignal![i]!];
      if (!nan(e5, e48) && e5 < e48) return { exit: true, reason: 'trend changed (EMA 5 below EMA 48)' };
      if (!Number.isNaN(r) && r < 50) return { exit: true, reason: `buying strength weak (RSI ${r.toFixed(0)} below 50)` };
      const pm = ind.macd![i - 1];
      const ps = ind.macdSignal![i - 1];
      if (!nan(m, s) && pm !== undefined && ps !== undefined && !nan(pm, ps) && pm >= ps && m < s) return { exit: true, reason: 'MACD crossed below its signal line' };
      return { exit: false, stop: t.stop, highestClose };
    },
  },
};

/** The configured strategy; a retired or unknown name (e.g. from an older version) uses the current strategy. */
export const strategyName = (cfg: StrategyConfig): StrategyName => (isStrategyName(cfg.name) ? cfg.name : DEFAULT_STRATEGY);
const def = (cfg: StrategyConfig) => DEFS[strategyName(cfg)];

/** Plain-language description of every strategy, for the website and reports. */
export const STRATEGIES: StrategyInfo[] = STRATEGY_IDS.map((id) => {
  const { warmup: _w, extras: _x, entry: _e, exit: _q, ...info } = DEFS[id];
  return info;
});

export function computeIndicators(candles: Candle[], cfg: StrategyConfig): Indicators {
  const closes = candles.map((c) => c.close);
  return {
    fast: ema(closes, cfg.fastEma),
    slow: ema(closes, cfg.slowEma),
    trend: ema(closes, cfg.trendEma),
    rsi: rsi(closes, cfg.rsiPeriod),
    atr: atr(candles, cfg.atrPeriod),
    ...def(cfg).extras(candles, cfg),
  };
}

/** Bars of history the configured strategy needs before it can signal. */
export const warmupBars = (cfg: StrategyConfig): number => def(cfg).warmup(cfg);

/** History needed by the most demanding strategy. */
export const maxWarmupBars = (cfg: StrategyConfig): number => Math.max(...STRATEGY_IDS.map((id) => DEFS[id].warmup(cfg)), cfg.trendEma + 2);

/** Long entry on bar `i`, evaluated at its close. */
export function entrySignal(candles: Candle[], ind: Indicators, i: number, cfg: StrategyConfig): EntryDecision {
  if (i < 0 || i >= candles.length) return { enter: false, reason: 'no such bar' };
  return def(cfg).entry(candles, ind, i, cfg);
}

/** Exit check for an open long at the close of bar `i`: exit now, or the (never lower) stop to use next. */
export function exitSignal(candles: Candle[], ind: Indicators, i: number, trade: OpenTrade, cfg: StrategyConfig): ExitDecision {
  return def(cfg).exit(candles, ind, i, trade, cfg);
}
