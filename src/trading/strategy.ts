import type { StrategyConfig } from '../config';
import type { Candle } from '../types';
import { atr, ema, highest, lowest, priorAverage, priorHighest, priorLowest, rsi, sma, supertrend } from './indicators';
import { DEFAULT_STRATEGY, STRATEGY_IDS, type StrategyName } from './strategyIds';

/**
 * Trading strategies. All are long-only, daily-candle rules evaluated at a bar's close, with standard
 * textbook settings that were NOT tuned on historical data. They differ only in when to buy and when to
 * sell; position sizing, risk limits, stop-loss orders and the kill switch are the same for all of them.
 * Every strategy sets its initial stop `stopAtr` ATRs below the entry close (Supertrend may use its band).
 */

export { STRATEGY_IDS, type StrategyName };

/** emaTrend's indicators are always present (the company study shows them); other strategies add theirs. */
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
  /** Average buy price, for rules such as "take profit at +25%". */
  entryPrice?: number;
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
  /** Who the rules come from, and the source, for the website. */
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
const atrStop = (close: number, a: number, cfg: StrategyConfig) => close - cfg.stopAtr * a;
/** Chandelier trail: `trailAtr` ATRs below the highest close; never moves down. */
function chandelier(c: Candle[], ind: Indicators, i: number, t: OpenTrade, cfg: StrategyConfig): ExitDecision {
  const highestClose = Math.max(t.highestClose, c[i]!.close);
  const a = ind.atr[i]!;
  const trail = Number.isNaN(a) ? t.stop : highestClose - cfg.trailAtr * a;
  return { exit: false, stop: Math.max(t.stop, trail), highestClose };
}

const DEFS: Record<StrategyName, StrategyDef> = {
  emaTrend: {
    id: 'emaTrend',
    name: 'EMA Trend',
    style: 'Trend following',
    summary: 'Buys when a short-term average crosses above a longer one while the stock is in a long-term uptrend.',
    buy: 'The 20-day EMA crosses above the 50-day EMA, the close is above the 200-day EMA, and RSI(14) is between 50 and 70 (strong, not overbought).',
    sell: 'The 20-day EMA falls below the 50-day EMA, or the trailing stop (3 ATR below the highest close) is hit.',
    suits: 'Steady, long trends. Gets whipsawed in sideways markets.',
    warmup: (cfg) => Math.max(cfg.slowEma, cfg.trendEma, cfg.rsiPeriod + 1, cfg.atrPeriod + 1) + 1,
    extras: () => ({}),
    entry(c, ind, i, cfg) {
      if (i < 1 || i < DEFS.emaTrend.warmup(cfg) - 1) return { enter: false, reason: 'not enough history' };
      const close = c[i]!.close;
      const [f, s, pf, ps] = [ind.fast[i]!, ind.slow[i]!, ind.fast[i - 1]!, ind.slow[i - 1]!];
      const [r, a, t] = [ind.rsi[i]!, ind.atr[i]!, ind.trend[i]!];
      if (nan(f, s, pf, ps, r, a, t)) return notReady;
      if (!(pf <= ps && f > s)) return { enter: false, reason: 'no bullish EMA crossover' };
      if (close <= t) return { enter: false, reason: `close below ${cfg.trendEma} EMA` };
      if (r < cfg.rsiMin || r > cfg.rsiMax) return { enter: false, reason: `RSI ${r.toFixed(1)} outside ${cfg.rsiMin}-${cfg.rsiMax}` };
      return { enter: true, stop: atrStop(close, a, cfg), reason: `EMA${cfg.fastEma} crossed above EMA${cfg.slowEma}, RSI ${r.toFixed(1)}, above EMA${cfg.trendEma}` };
    },
    exit(c, ind, i, t, cfg) {
      if (ind.fast[i]! < ind.slow[i]!) return { exit: true, reason: `EMA${cfg.fastEma} below EMA${cfg.slowEma}` };
      return chandelier(c, ind, i, t, cfg);
    },
  },

  donchian: {
    id: 'donchian',
    name: 'Donchian Breakout',
    style: 'Breakout (Turtle style)',
    summary: 'Buys when the price breaks above its highest point of the last 55 trading days; sells on a break below the 20-day low.',
    buy: 'The close breaks above the highest high of the previous 55 days (a fresh breakout, not already above it yesterday).',
    sell: 'The close falls below the lowest low of the previous 20 days; the stop also trails up to that 20-day low.',
    suits: 'Big trending moves. Many small losses on false breakouts.',
    inspiredBy: 'Richard Dennis and the Turtle Traders',
    source: 'The Turtle Trading rules (55-day breakout, 20-day exit), as published by Curtis Faith.',
    warmup: () => 57,
    extras: (c) => ({ hi55: priorHighest(c.map((x) => x.high), 55), lo20: priorLowest(c.map((x) => x.low), 20) }),
    entry(c, ind, i, cfg) {
      if (i < 1) return notReady;
      const [h, hp, a] = [ind.hi55![i]!, ind.hi55![i - 1]!, ind.atr[i]!];
      if (nan(h, hp, a)) return notReady;
      const close = c[i]!.close;
      if (!(close > h && c[i - 1]!.close <= hp)) return { enter: false, reason: 'no fresh 55-day breakout' };
      return { enter: true, stop: atrStop(close, a, cfg), reason: `close ${close.toFixed(2)} broke the 55-day high ${h.toFixed(2)}` };
    },
    exit(c, ind, i, t) {
      const lo = ind.lo20![i]!;
      const close = c[i]!.close;
      const highestClose = Math.max(t.highestClose, close);
      if (!Number.isNaN(lo) && close < lo) return { exit: true, reason: `close below the 20-day low ${lo.toFixed(2)}` };
      return { exit: false, stop: Number.isNaN(lo) ? t.stop : Math.max(t.stop, lo), highestClose };
    },
  },

  momentum52: {
    id: 'momentum52',
    name: '52-Week High Momentum',
    style: 'Momentum',
    summary: 'Buys strong stocks making a new 20-day high within 5% of their 52-week high, in a rising long-term trend.',
    buy: 'Close within 5% of the 52-week high, close above the 50-day average and the 50-day above the 200-day, the 200-day rising over the last month, and a fresh 20-day closing high.',
    sell: 'The close falls below the 50-day average, or the trailing stop (3 ATR below the highest close) is hit.',
    suits: 'Strong bull markets and market leaders. Can buy near tops before sharp pullbacks.',
    inspiredBy: '52-week-high momentum research',
    source: 'George & Hwang, "The 52-Week High and Momentum Investing", Journal of Finance (2004).',
    warmup: () => 253,
    extras(c) {
      const closes = c.map((x) => x.close);
      return { sma50: sma(closes, 50), sma200: sma(closes, 200), hi252: highest(closes, 252), hi20: priorHighest(closes, 20) };
    },
    entry(c, ind, i, cfg) {
      if (i < 21) return notReady;
      const close = c[i]!.close;
      const [s50, s200, s200m, h252, h20, h20p, a] = [ind.sma50![i]!, ind.sma200![i]!, ind.sma200![i - 20]!, ind.hi252![i]!, ind.hi20![i]!, ind.hi20![i - 1]!, ind.atr[i]!];
      if (nan(s50, s200, s200m, h252, h20, h20p, a)) return notReady;
      if (close < 0.95 * h252) return { enter: false, reason: 'more than 5% below the 52-week high' };
      if (!(close > s50 && s50 > s200)) return { enter: false, reason: 'not above the 50- and 200-day averages' };
      if (!(s200 > s200m)) return { enter: false, reason: '200-day average not rising' };
      if (!(close > h20 && c[i - 1]!.close <= h20p)) return { enter: false, reason: 'no fresh 20-day closing high' };
      return { enter: true, stop: atrStop(close, a, cfg), reason: `new 20-day high ${((close / h252 - 1) * 100).toFixed(1)}% from the 52-week high, uptrend confirmed` };
    },
    exit(c, ind, i, t, cfg) {
      const s50 = ind.sma50![i]!;
      if (!Number.isNaN(s50) && c[i]!.close < s50) return { exit: true, reason: 'close below the 50-day average' };
      return chandelier(c, ind, i, t, cfg);
    },
  },

  rsi2: {
    id: 'rsi2',
    name: 'RSI-2 Pullback',
    style: 'Mean reversion',
    summary: 'Buys a short, sharp dip in a stock that is in a long-term uptrend, and sells on the bounce.',
    buy: 'The close is above the 200-day average and the 2-day RSI is below 10 (an oversold dip).',
    sell: 'The close rises above the 5-day average (the bounce), or the stop (2 ATR below entry) is hit.',
    suits: 'Choppy markets with an upward bias. Short holding periods; suffers in crashes.',
    inspiredBy: 'Larry Connors',
    source: 'Connors & Alvarez, Short Term Trading Strategies That Work (RSI(2) pullbacks above the 200-day average).',
    warmup: () => 202,
    extras(c) {
      const closes = c.map((x) => x.close);
      return { rsi2: rsi(closes, 2), sma200: sma(closes, 200), sma5: sma(closes, 5) };
    },
    entry(c, ind, i, cfg) {
      const close = c[i]!.close;
      const [r2, s200, a] = [ind.rsi2![i]!, ind.sma200![i]!, ind.atr[i]!];
      if (nan(r2, s200, a)) return notReady;
      if (close <= s200) return { enter: false, reason: 'below the 200-day average' };
      if (r2 >= 10) return { enter: false, reason: `RSI(2) ${r2.toFixed(1)} not below 10` };
      return { enter: true, stop: atrStop(close, a, cfg), reason: `RSI(2) ${r2.toFixed(1)} dip above the 200-day average` };
    },
    exit(c, ind, i, t) {
      const s5 = ind.sma5![i]!;
      const close = c[i]!.close;
      if (!Number.isNaN(s5) && close > s5) return { exit: true, reason: 'bounced above the 5-day average' };
      return { exit: false, stop: t.stop, highestClose: Math.max(t.highestClose, close) };
    },
  },

  supertrend: {
    id: 'supertrend',
    name: 'Supertrend',
    style: 'Trend following',
    summary: 'Follows the Supertrend (10, 3) indicator: buys when it turns up, sells when it turns down.',
    buy: 'Supertrend (10-day ATR, factor 3) flips from down to up.',
    sell: 'Supertrend flips down. The stop trails up with the Supertrend line.',
    suits: 'Clear trends of a few weeks or more. Lags at turning points.',
    inspiredBy: 'Olivier Seban (Supertrend indicator)',
    source: 'Supertrend: ATR bands around the bar midpoint, factor 3, 10-day ATR (common default).',
    warmup: () => 13,
    extras(c) {
      const st = supertrend(c, 10, 3);
      return { st: st.value, stDir: st.dir };
    },
    entry(c, ind, i, cfg) {
      if (i < 1) return notReady;
      const [d, dp, v, a] = [ind.stDir![i]!, ind.stDir![i - 1]!, ind.st![i]!, ind.atr[i]!];
      if (nan(d, dp, v, a)) return notReady;
      if (!(d === 1 && dp === -1)) return { enter: false, reason: 'Supertrend did not flip up' };
      const close = c[i]!.close;
      const stop = v > 0 && v < close ? Math.min(v, close - 0.5 * a) : atrStop(close, a, cfg);
      return { enter: true, stop, reason: `Supertrend flipped up (line ${v.toFixed(2)})` };
    },
    exit(c, ind, i, t) {
      const [d, v] = [ind.stDir![i]!, ind.st![i]!];
      const close = c[i]!.close;
      if (d === -1) return { exit: true, reason: 'Supertrend flipped down' };
      return { exit: false, stop: Number.isNaN(v) || v >= close ? t.stop : Math.max(t.stop, v), highestClose: Math.max(t.highestClose, close) };
    },
  },

  minervini: {
    id: 'minervini',
    name: 'Minervini Trend Template',
    style: 'Momentum (SEPA)',
    summary: 'Only buys stocks in a confirmed Stage 2 uptrend (Minervini\'s 8-point Trend Template) when they break out to a new short-term high on strong volume.',
    buy: 'All of: close above the 50-, 150- and 200-day averages; 50 above 150 above 200; the 200-day rising for a month; at least 30% above the 52-week low and within 25% of the 52-week high. Then buy a fresh 20-day closing high on volume at least 40% above its 50-day average.',
    sell: 'The close falls below the 50-day average, or the stop is hit (at most 8% below the buy, or 2 ATR if tighter), trailing 3 ATR below the highest close.',
    suits: 'Strong markets and leading stocks. Many small, quick losses; relies on a few big winners.',
    inspiredBy: 'Mark Minervini',
    source: 'Mark Minervini, Trade Like a Stock Market Wizard (Trend Template, SEPA). His relative-strength ranking against all stocks is not included: it needs the whole market\'s data.',
    warmup: () => 275,
    extras(c) {
      const closes = c.map((x) => x.close);
      return {
        sma50: sma(closes, 50), sma150: sma(closes, 150), sma200: sma(closes, 200),
        hi252: highest(c.map((x) => x.high), 252), lo252: lowest(c.map((x) => x.low), 252),
        hi20: priorHighest(closes, 20), vol50: priorAverage(c.map((x) => x.volume), 50),
      };
    },
    entry(c, ind, i, cfg) {
      if (i < 22) return notReady;
      const close = c[i]!.close;
      const [s50, s150, s200, s200m, hi, lo, h20, h20p, v50, a] = [ind.sma50![i]!, ind.sma150![i]!, ind.sma200![i]!, ind.sma200![i - 21]!, ind.hi252![i]!, ind.lo252![i]!, ind.hi20![i]!, ind.hi20![i - 1]!, ind.vol50![i]!, ind.atr[i]!];
      if (nan(s50, s150, s200, s200m, hi, lo, h20, h20p, v50, a)) return notReady;
      const template = close > s150 && close > s200 && s150 > s200 && s200 > s200m && s50 > s150 && s50 > s200 && close > s50 && close >= 1.3 * lo && close >= 0.75 * hi;
      if (!template) return { enter: false, reason: 'not in a Trend Template uptrend' };
      if (!(close > h20 && c[i - 1]!.close <= h20p)) return { enter: false, reason: 'no fresh 20-day closing high' };
      if (!(v50 > 0 && c[i]!.volume >= 1.4 * v50)) return { enter: false, reason: 'breakout volume not 40% above average' };
      return { enter: true, stop: Math.max(atrStop(close, a, cfg), close * 0.92), reason: `Trend Template uptrend, breakout on ${(c[i]!.volume / v50).toFixed(1)}x average volume` };
    },
    exit(c, ind, i, t, cfg) {
      const s50 = ind.sma50![i]!;
      if (!Number.isNaN(s50) && c[i]!.close < s50) return { exit: true, reason: 'close below the 50-day average' };
      return chandelier(c, ind, i, t, cfg);
    },
  },

  canslim: {
    id: 'canslim',
    name: 'CAN SLIM breakout',
    style: 'Growth breakout',
    summary: 'William O\'Neil\'s buy point: a stock near its highs breaks out of a base of at least ten weeks on heavy volume. Strict 8% stop, profits taken at +25%.',
    buy: 'The close breaks above the highest close of the previous 50 days (the base), within 15% of the 52-week high, on volume at least 40% above its 50-day average.',
    sell: 'Take profit at +25% from the buy price; sell if the close falls below the 50-day average; the stop is 8% below the buy price.',
    suits: 'Bull markets and fast-growing companies (use with the CAN SLIM fundamentals style).',
    inspiredBy: 'William O\'Neil',
    source: 'William O\'Neil, How to Make Money in Stocks (N: new highs, S: volume, the 7-8% loss rule, 20-25% profit taking). The M (market direction) filter is not automated yet: pause new buys in a falling market.',
    warmup: () => 253,
    extras(c) {
      const closes = c.map((x) => x.close);
      return { base50: priorHighest(closes, 50), hi252: highest(c.map((x) => x.high), 252), vol50: priorAverage(c.map((x) => x.volume), 50), sma50: sma(closes, 50) };
    },
    entry(c, ind, i) {
      if (i < 1) return notReady;
      const close = c[i]!.close;
      const [b, bp, hi, v50] = [ind.base50![i]!, ind.base50![i - 1]!, ind.hi252![i]!, ind.vol50![i]!];
      if (nan(b, bp, hi, v50)) return notReady;
      if (!(close > b && c[i - 1]!.close <= bp)) return { enter: false, reason: 'no fresh breakout from a 50-day base' };
      if (close < 0.85 * hi) return { enter: false, reason: 'more than 15% below the 52-week high' };
      if (!(v50 > 0 && c[i]!.volume >= 1.4 * v50)) return { enter: false, reason: 'breakout volume not 40% above average' };
      return { enter: true, stop: close * 0.92, reason: `base breakout on ${(c[i]!.volume / v50).toFixed(1)}x average volume` };
    },
    exit(c, ind, i, t) {
      const close = c[i]!.close;
      if (t.entryPrice && close >= t.entryPrice * 1.25) return { exit: true, reason: 'took profit at +25% (O\'Neil\'s 20-25% rule)' };
      const s50 = ind.sma50![i]!;
      if (!Number.isNaN(s50) && close < s50) return { exit: true, reason: 'close below the 50-day average' };
      return { exit: false, stop: t.stop, highestClose: Math.max(t.highestClose, close) };
    },
  },

  weinstein: {
    id: 'weinstein',
    name: 'Weinstein Stage 2',
    style: 'Stage analysis',
    summary: 'Buys when a stock leaves its base and starts Stage 2: a breakout above resistance, above a rising 30-week (150-day) average, on double volume. Sells when Stage 2 ends.',
    buy: 'Close above a rising 150-day average (the 30-week line) and a fresh break above the highest close of the previous 50 days, on volume at least twice its 50-day average.',
    sell: 'The close falls below the 150-day average (Stage 3/4 starting); the stop also trails up to 5% below that average.',
    suits: 'Long, steady advances lasting months. Slow to react; avoids most of a Stage 4 decline.',
    inspiredBy: 'Stan Weinstein',
    source: 'Stan Weinstein, Secrets for Profiting in Bull and Bear Markets. Weekly rules adapted to daily data (30 weeks = 150 days; volume at least 2x average).',
    warmup: () => 172,
    extras(c) {
      const closes = c.map((x) => x.close);
      return { sma150: sma(closes, 150), base50: priorHighest(closes, 50), vol50: priorAverage(c.map((x) => x.volume), 50) };
    },
    entry(c, ind, i, cfg) {
      if (i < 21) return notReady;
      const close = c[i]!.close;
      const [m, mp, b, bp, v50, a] = [ind.sma150![i]!, ind.sma150![i - 20]!, ind.base50![i]!, ind.base50![i - 1]!, ind.vol50![i]!, ind.atr[i]!];
      if (nan(m, mp, b, bp, v50, a)) return notReady;
      if (!(close > m && m > mp)) return { enter: false, reason: 'not above a rising 30-week average' };
      if (!(close > b && c[i - 1]!.close <= bp)) return { enter: false, reason: 'no fresh breakout above resistance' };
      if (!(v50 > 0 && c[i]!.volume >= 2 * v50)) return { enter: false, reason: 'breakout volume not twice the average' };
      return { enter: true, stop: atrStop(close, a, cfg), reason: `Stage 2 breakout on ${(c[i]!.volume / v50).toFixed(1)}x average volume` };
    },
    exit(c, ind, i, t) {
      const m = ind.sma150![i]!;
      const close = c[i]!.close;
      if (!Number.isNaN(m) && close < m) return { exit: true, reason: 'close below the 30-week (150-day) average' };
      return { exit: false, stop: Number.isNaN(m) ? t.stop : Math.max(t.stop, m * 0.95), highestClose: Math.max(t.highestClose, close) };
    },
  },

  buyHold: {
    id: 'buyHold',
    name: 'Buy right, sit tight',
    style: 'Long-term investing',
    summary: 'For the investor styles (Buffett, QGLP, Jhunjhunwala...): buy a watchlist company when its long-term trend is up and the price is not stretched, then hold for as long as the long-term trend lasts.',
    buy: 'Close above a rising 200-day average (rising over the last month) and no more than 15% above it, so the buy is not chasing a spike.',
    sell: 'Only when the close falls more than 10% below the 200-day average (the long-term trend has broken). The stop trails up to that level and never down.',
    suits: 'Quality companies in long uptrends. Few trades; wide stops mean smaller positions and bigger swings.',
    inspiredBy: 'Rakesh Jhunjhunwala and Raamdeo Agrawal ("buy right, sit tight")',
    source: 'The long-holding philosophy of Jhunjhunwala and Agrawal\'s QGLP ("Buy Right, Sit Tight"). The 200-day trend rule is a mechanical stand-in for their judgement on when a thesis is broken.',
    warmup: () => 222,
    extras(c) {
      return { sma200: sma(c.map((x) => x.close), 200) };
    },
    entry(c, ind, i) {
      if (i < 21) return notReady;
      const close = c[i]!.close;
      const [m, mp] = [ind.sma200![i]!, ind.sma200![i - 21]!];
      if (nan(m, mp)) return notReady;
      if (!(close > m && m > mp)) return { enter: false, reason: 'not above a rising 200-day average' };
      if (close > 1.15 * m) return { enter: false, reason: 'more than 15% above the 200-day average (stretched)' };
      return { enter: true, stop: Math.min(m * 0.9, close * 0.85), reason: `long-term uptrend, ${((close / m - 1) * 100).toFixed(1)}% above the 200-day average` };
    },
    exit(c, ind, i, t) {
      const m = ind.sma200![i]!;
      const close = c[i]!.close;
      if (!Number.isNaN(m) && close < m * 0.9) return { exit: true, reason: 'more than 10% below the 200-day average: long-term trend broken' };
      return { exit: false, stop: Number.isNaN(m) ? t.stop : Math.max(t.stop, m * 0.9), highestClose: Math.max(t.highestClose, close) };
    },
  },

};

export const strategyName = (cfg: StrategyConfig): StrategyName => cfg.name ?? DEFAULT_STRATEGY;
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

/** History needed by the most demanding strategy (so switching strategies never runs short of data). */
export const maxWarmupBars = (cfg: StrategyConfig): number => Math.max(...STRATEGY_IDS.map((id) => DEFS[id].warmup(cfg)));

/** Long entry on bar `i`, evaluated at its close. */
export function entrySignal(candles: Candle[], ind: Indicators, i: number, cfg: StrategyConfig): EntryDecision {
  if (i < 0 || i >= candles.length) return { enter: false, reason: 'no such bar' };
  return def(cfg).entry(candles, ind, i, cfg);
}

/** Exit check for an open long at the close of bar `i`: exit now, or the (never lower) stop to use next. */
export function exitSignal(candles: Candle[], ind: Indicators, i: number, trade: OpenTrade, cfg: StrategyConfig): ExitDecision {
  return def(cfg).exit(candles, ind, i, trade, cfg);
}
