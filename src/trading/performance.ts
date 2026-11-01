import type { PortfolioResult, PortfolioTrade } from './portfolioBacktest';
import { cagr, maxDrawdown, periodReturns, sharpe, yearsBetween } from './stats';

export interface PerformanceSummary {
  label: string;
  from: string;
  to: string;
  days: number;
  startValue: number;
  endValue: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  // Strategy only
  trades?: number;
  winRate?: number;
  profitFactor?: number;
  avgWin?: number;
  avgLoss?: number;
  exposure?: number;
  cashUtilization?: number;
  costs?: number;
}

const date = (d: string) => new Date(`${d}T00:00:00Z`);

/**
 * Summarises an equity curve between two days (inclusive). The value on the day before `from`
 * (or the starting capital) is the base, so sub-periods chain correctly.
 */
export function summarizeCurve(label: string, curve: { day: string; equity: number }[], from: string, to: string, base?: number): PerformanceSummary {
  const idx = curve.findIndex((p) => p.day >= from);
  const slice = curve.filter((p) => p.day >= from && p.day <= to);
  if (slice.length === 0) throw new Error(`No data between ${from} and ${to}`);
  const startValue = base ?? (idx > 0 ? curve[idx - 1]!.equity : slice[0]!.equity);
  const values = slice.map((p) => p.equity);
  const endValue = values.at(-1)!;
  const startDay = idx > 0 ? curve[idx - 1]!.day : slice[0]!.day;
  return {
    label,
    from: slice[0]!.day,
    to: slice.at(-1)!.day,
    days: slice.length,
    startValue,
    endValue,
    totalReturn: endValue / startValue - 1,
    cagr: cagr(startValue, endValue, yearsBetween(date(startDay), date(slice.at(-1)!.day))),
    maxDrawdown: maxDrawdown(values, startValue),
    sharpe: sharpe(periodReturns(values, startValue)),
  };
}

export function tradeStats(trades: PortfolioTrade[]) {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.netPnl, 0);
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
  };
}

/** Strategy summary for a period: curve statistics plus trade, exposure, utilisation and cost figures. */
export function summarizeStrategy(r: PortfolioResult, from: string, to: string, base?: number): PerformanceSummary {
  const s = summarizeCurve('Strategy', r.curve, from, to, base);
  const days = r.curve.filter((p) => p.day >= from && p.day <= to);
  const closed = r.trades.filter((t) => t.exitDay >= from && t.exitDay <= to);
  const costs = closed.reduce((a, t) => a + t.costs, 0);
  return {
    ...s,
    ...tradeStats(closed),
    exposure: days.filter((p) => p.positions > 0).length / days.length,
    cashUtilization: days.reduce((a, p) => a + (p.equity > 0 ? p.invested / p.equity : 0), 0) / days.length,
    costs,
  };
}
