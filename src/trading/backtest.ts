import type { RiskConfig, StrategyConfig, TradingConfig } from '../config';
import type { Candle } from '../types';
import { dayKey, runPortfolioBacktest } from './portfolioBacktest';
import { cagr, maxDrawdown, periodReturns, sharpe, yearsBetween } from './stats';

export interface BacktestTrade {
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  /** P&L in multiples of the initial risk (entry - initial stop). */
  rMultiple: number;
  exitReason: string;
}

export interface BacktestResult {
  symbol: string;
  trades: BacktestTrade[];
  equityCurve: { time: Date; equity: number }[];
  metrics: Metrics;
}

export interface Metrics {
  startEquity: number;
  endEquity: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  exposure: number;
}

/**
 * Single-symbol backtest: the portfolio backtester run on one stock with at most one position, so
 * both share the same execution rules (signal at a close, fill at the next session's open, stops
 * intraday, gaps filled at the open, itemised costs, slippage). Any open position is sold at the
 * final close.
 */
export function backtest(
  symbol: string,
  candles: Candle[],
  cfg: { strategy: StrategyConfig; risk: RiskConfig; backtest: TradingConfig['backtest'] },
): BacktestResult {
  const { initialCapital, slippagePct, costs } = cfg.backtest;
  const days = candles.map((c) => dayKey(c.time));
  if (days.length === 0) return { symbol, trades: [], equityCurve: [], metrics: computeMetrics(initialCapital, [], [], 0) };
  const r = runPortfolioBacktest(
    { [symbol]: candles },
    { strategy: cfg.strategy, risk: { ...cfg.risk, maxOpenPositions: 1 }, costs, slippagePct, initialCapital, start: days[0]!, end: days.at(-1)!, liquidateAtEnd: true },
  );
  const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
  const trades: BacktestTrade[] = r.trades.map((t) => ({
    entryTime: toDate(t.entryDay),
    exitTime: toDate(t.exitDay),
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    qty: t.qty,
    pnl: t.netPnl,
    rMultiple: t.netPnl / ((t.entryPrice - t.initialStop) * t.qty),
    exitReason: t.exitReason,
  }));
  const equityCurve = r.curve.map((p) => ({ time: toDate(p.day), equity: p.equity }));
  return { symbol, trades, equityCurve, metrics: computeMetrics(initialCapital, equityCurve, trades, r.curve.filter((p) => p.positions > 0).length) };
}

export function computeMetrics(
  startEquity: number,
  curve: { time: Date; equity: number }[],
  trades: BacktestTrade[],
  barsInMarket: number,
): Metrics {
  const values = curve.map((p) => p.equity);
  const endEquity = values.at(-1) ?? startEquity;
  const years = curve.length > 1 ? yearsBetween(curve[0]!.time, curve.at(-1)!.time) : 0;
  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return {
    startEquity,
    endEquity,
    totalReturn: endEquity / startEquity - 1,
    cagr: cagr(startEquity, endEquity, years),
    maxDrawdown: maxDrawdown(values, startEquity),
    sharpe: sharpe(periodReturns(values, startEquity)),
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgR: trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0,
    exposure: curve.length ? barsInMarket / curve.length : 0,
  };
}
