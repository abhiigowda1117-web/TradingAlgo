import type { StrategyConfig } from '../config';
import type { Candle } from '../types';
import { atr, ema, rsi } from './indicators';

export interface Indicators {
  fast: number[];
  slow: number[];
  trend: number[];
  rsi: number[];
  atr: number[];
}

export function computeIndicators(candles: Candle[], cfg: StrategyConfig): Indicators {
  const closes = candles.map((c) => c.close);
  return {
    fast: ema(closes, cfg.fastEma),
    slow: ema(closes, cfg.slowEma),
    trend: ema(closes, cfg.trendEma),
    rsi: rsi(closes, cfg.rsiPeriod),
    atr: atr(candles, cfg.atrPeriod),
  };
}

export function warmupBars(cfg: StrategyConfig): number {
  return Math.max(cfg.slowEma, cfg.trendEma, cfg.rsiPeriod + 1, cfg.atrPeriod + 1) + 1;
}

export type EntryDecision =
  | { enter: true; stop: number; reason: string }
  | { enter: false; reason: string };

/**
 * Long entry on bar `i` (evaluated at its close): the fast EMA crosses above the slow EMA,
 * the close is above the long-term trend EMA, and RSI is in the momentum band
 * (strong but not overbought). The initial stop sits `stopAtr` ATRs below the close.
 */
export function entrySignal(candles: Candle[], ind: Indicators, i: number, cfg: StrategyConfig): EntryDecision {
  if (i < 1 || i < warmupBars(cfg) - 1) return { enter: false, reason: 'not enough history' };
  const c = candles[i]!;
  const [f, s, pf, ps] = [ind.fast[i]!, ind.slow[i]!, ind.fast[i - 1]!, ind.slow[i - 1]!];
  const r = ind.rsi[i]!;
  const a = ind.atr[i]!;
  const t = ind.trend[i]!;
  if ([f, s, pf, ps, r, a, t].some(Number.isNaN)) return { enter: false, reason: 'indicators not ready' };
  if (!(pf <= ps && f > s)) return { enter: false, reason: 'no bullish EMA crossover' };
  if (c.close <= t) return { enter: false, reason: `close below ${cfg.trendEma} EMA` };
  if (r < cfg.rsiMin || r > cfg.rsiMax) return { enter: false, reason: `RSI ${r.toFixed(1)} outside ${cfg.rsiMin}-${cfg.rsiMax}` };
  return {
    enter: true,
    stop: c.close - cfg.stopAtr * a,
    reason: `EMA${cfg.fastEma} crossed above EMA${cfg.slowEma}, RSI ${r.toFixed(1)}, above EMA${cfg.trendEma}`,
  };
}

export interface OpenTrade {
  stop: number;
  highestClose: number;
}

export type ExitDecision = { exit: true; reason: string } | { exit: false; stop: number; highestClose: number };

/**
 * Evaluated at the close of bar `i` for an open long. Exits on a bearish EMA crossover;
 * otherwise ratchets a chandelier trailing stop (`trailAtr` ATRs below the highest close),
 * which never moves down.
 */
export function exitSignal(candles: Candle[], ind: Indicators, i: number, trade: OpenTrade, cfg: StrategyConfig): ExitDecision {
  const c = candles[i]!;
  const [f, s] = [ind.fast[i]!, ind.slow[i]!];
  if (f < s) return { exit: true, reason: `EMA${cfg.fastEma} below EMA${cfg.slowEma}` };
  const highestClose = Math.max(trade.highestClose, c.close);
  const a = ind.atr[i]!;
  const trail = Number.isNaN(a) ? trade.stop : highestClose - cfg.trailAtr * a;
  return { exit: false, stop: Math.max(trade.stop, trail), highestClose };
}
