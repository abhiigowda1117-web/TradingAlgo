import type { RiskConfig, TradingConfig } from '../config';
import { hhmm, NSE_CLOSE, NSE_OPEN } from '../util/time';

export const isPositive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

export interface SizingInput {
  equity: number;
  cash: number;
  price: number;
  stop: number;
  /** Market value of positions already held (plus in-flight entries). */
  exposure?: number;
}

export interface CostModel {
  costPct: number;
  slippagePct: number;
  /** Extra slippage when a stop-limit fills below its trigger. */
  stopBufferPct: number;
}

export type SizingResult = { qty: number; reason: string };

/**
 * Worst-case loss per share if the stop is hit: entry slippage, a fill at the bottom of the
 * stop-limit band, exit slippage, and costs on both sides.
 */
export function riskPerShare(price: number, stop: number, c: CostModel): number {
  const entry = price * (1 + c.slippagePct);
  const exit = stop * (1 - c.stopBufferPct) * (1 - c.slippagePct);
  return entry - exit + (entry + exit) * c.costPct;
}

/**
 * Fixed-fractional sizing: lose at most `riskPerTrade` of equity if the stop is hit (after costs
 * and slippage), capped by position size, total exposure, the per-order value limit and cash.
 * Whole shares only. Any invalid input yields zero shares.
 */
export function positionSize({ equity, cash, price, stop, exposure = 0 }: SizingInput, cfg: RiskConfig, costs?: CostModel): SizingResult {
  if (!isPositive(equity)) return { qty: 0, reason: `invalid equity ${equity}` };
  if (!Number.isFinite(cash) || cash < 0) return { qty: 0, reason: `invalid cash ${cash}` };
  if (!isPositive(price)) return { qty: 0, reason: `invalid price ${price}` };
  if (!isPositive(stop)) return { qty: 0, reason: `invalid stop ${stop}` };
  if (!Number.isFinite(exposure) || exposure < 0) return { qty: 0, reason: `invalid exposure ${exposure}` };
  if (stop >= price) return { qty: 0, reason: 'stop must be below price' };

  const perShareRisk = costs ? riskPerShare(price, stop, costs) : price - stop;
  const unitCost = price * (1 + (costs?.slippagePct ?? 0)) * (1 + (costs?.costPct ?? 0));
  const caps = {
    risk: Math.floor((equity * cfg.riskPerTrade) / perShareRisk),
    'position size': Math.floor((equity * cfg.maxPositionPct) / price),
    'total exposure': Math.floor(Math.max(0, equity * cfg.maxTotalExposurePct - exposure) / price),
    'order value': Math.floor(cfg.maxOrderValue / price),
    cash: Math.floor(cash / unitCost),
  };
  const [binding, qty] = Object.entries(caps).reduce((a, b) => (b[1] < a[1] ? b : a));
  if (!Number.isFinite(qty) || qty < 1) return { qty: 0, reason: `${binding} limit allows less than 1 share` };
  return { qty, reason: `sized by ${binding} limit` };
}

export function dailyLossBreached(dayStartEquity: number, equity: number, cfg: RiskConfig): boolean {
  if (!isPositive(dayStartEquity) || !Number.isFinite(equity)) return true; // unknown equity: fail safe
  return (dayStartEquity - equity) / dayStartEquity >= cfg.maxDailyLossPct;
}

/**
 * The LTP must be a positive number close to the latest candle close. A big gap usually means a
 * bad tick or stale candles, and trading on it would size and place stops wrongly.
 */
export function validateEntryPrice(ltp: number | undefined, candleClose: number, maxDeviationPct: number): string | undefined {
  if (ltp === undefined) return 'no live price';
  if (!isPositive(ltp)) return `invalid live price ${ltp}`;
  if (!isPositive(candleClose)) return `invalid candle close ${candleClose}`;
  const dev = Math.abs(ltp / candleClose - 1);
  if (dev > maxDeviationPct) return `live price ₹${ltp} is ${(dev * 100).toFixed(1)}% from candle close ₹${candleClose.toFixed(2)}`;
  return undefined;
}

/** Returns every problem with the trading config. An empty list means it is safe to load. */
export function validateTradingConfig(cfg: TradingConfig): string[] {
  const errs: string[] = [];
  const num = (path: string, v: unknown, min: number, max: number, opts: { int?: boolean; minExclusive?: boolean } = {}) => {
    const bad =
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      (opts.int && !Number.isInteger(v)) ||
      (opts.minExclusive ? v <= min : v < min) ||
      v > max;
    if (bad) errs.push(`${path} must be ${opts.int ? 'an integer' : 'a number'} ${opts.minExclusive ? '>' : '>='} ${min} and <= ${max} (got ${JSON.stringify(v)})`);
  };
  const s = cfg?.strategy;
  const r = cfg?.risk;
  const e = cfg?.engine;
  const b = cfg?.backtest;
  if (!s || !r || !e || !b) return ['config must have strategy, risk, engine and backtest sections'];

  for (const k of ['fastEma', 'slowEma', 'trendEma', 'rsiPeriod', 'atrPeriod'] as const) num(`strategy.${k}`, s[k], 2, 500, { int: true });
  if (s.fastEma >= s.slowEma) errs.push('strategy.fastEma must be less than strategy.slowEma');
  num('strategy.rsiMin', s.rsiMin, 0, 100);
  num('strategy.rsiMax', s.rsiMax, 0, 100);
  if (s.rsiMin >= s.rsiMax) errs.push('strategy.rsiMin must be less than strategy.rsiMax');
  num('strategy.stopAtr', s.stopAtr, 0, 10, { minExclusive: true });
  num('strategy.trailAtr', s.trailAtr, 0, 20, { minExclusive: true });

  num('risk.riskPerTrade', r.riskPerTrade, 0, 0.05, { minExclusive: true });
  num('risk.maxPositionPct', r.maxPositionPct, 0, 1, { minExclusive: true });
  num('risk.maxTotalExposurePct', r.maxTotalExposurePct, 0, 1, { minExclusive: true });
  num('risk.maxOpenPositions', r.maxOpenPositions, 1, 50, { int: true });
  num('risk.maxDailyLossPct', r.maxDailyLossPct, 0, 0.2, { minExclusive: true });
  num('risk.maxOrderValue', r.maxOrderValue, 0, 1e9, { minExclusive: true });
  num('risk.maxPriceDeviationPct', r.maxPriceDeviationPct, 0, 0.2, { minExclusive: true });

  num('engine.pollSeconds', e.pollSeconds, 5, 3600);
  num('engine.watchlistMaxAgeDays', e.watchlistMaxAgeDays, 0, 60, { minExclusive: true });
  num('engine.stopLimitBufferPct', e.stopLimitBufferPct, 0, 0.05, { minExclusive: true });
  num('engine.orderTimeoutSeconds', e.orderTimeoutSeconds, 5, 600);
  num('engine.triggeredStopGraceSeconds', e.triggeredStopGraceSeconds, 0, 600);
  if (e.product !== 'CNC') errs.push('engine.product must be "CNC"');
  if (e.exchange !== 'NSE' && e.exchange !== 'BSE') errs.push('engine.exchange must be "NSE" or "BSE"');
  try {
    const t = hhmm(e.evaluateAt);
    if (t < NSE_OPEN || t >= NSE_CLOSE) errs.push('engine.evaluateAt must be within market hours (09:15-15:30 IST)');
  } catch (err) {
    errs.push(`engine.evaluateAt: ${(err as Error).message}`);
  }
  if (!Array.isArray(e.holidays) || e.holidays.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) errs.push('engine.holidays must be a list of "YYYY-MM-DD" dates');

  num('backtest.initialCapital', b.initialCapital, 0, 1e12, { minExclusive: true });
  num('backtest.costPct', b.costPct, 0, 0.02);
  num('backtest.slippagePct', b.slippagePct, 0, 0.05);
  const c = b.costs;
  if (!c) errs.push('backtest.costs is required (itemised delivery charges)');
  else {
    num('backtest.costs.brokeragePct', c.brokeragePct, 0, 0.01);
    num('backtest.costs.brokerageMaxPerOrder', c.brokerageMaxPerOrder, 0, 1000);
    num('backtest.costs.sttPct', c.sttPct, 0, 0.01);
    num('backtest.costs.exchangePct', c.exchangePct, 0, 0.001);
    num('backtest.costs.sebiPct', c.sebiPct, 0, 0.0001);
    num('backtest.costs.stampBuyPct', c.stampBuyPct, 0, 0.001);
    num('backtest.costs.gstPct', c.gstPct, 0, 0.5);
    num('backtest.costs.dpChargePerSell', c.dpChargePerSell, 0, 100);
  }
  return errs;
}

export function costModel(cfg: TradingConfig): CostModel {
  return { costPct: cfg.backtest.costPct, slippagePct: cfg.backtest.slippagePct, stopBufferPct: cfg.engine.stopLimitBufferPct };
}
