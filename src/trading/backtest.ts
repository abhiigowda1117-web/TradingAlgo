import type { RiskConfig, StrategyConfig, TradingConfig } from '../config';
import type { Candle } from '../types';
import { positionSize } from './risk';
import { computeIndicators, entrySignal, exitSignal } from './strategy';

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

interface Position {
  qty: number;
  entryPrice: number;
  entryTime: Date;
  initialStop: number;
  stop: number;
  highestClose: number;
  entryCost: number;
}

/**
 * Bar-by-bar long-only backtest on one symbol. Signals are evaluated at the bar close and filled
 * at that close (the live engine trades just before the close). Stops are checked against the
 * next bars' lows; a gap below the stop fills at the open. Costs and slippage apply on both sides.
 */
export function backtest(
  symbol: string,
  candles: Candle[],
  cfg: { strategy: StrategyConfig; risk: RiskConfig; backtest: TradingConfig['backtest'] },
): BacktestResult {
  const { costPct, slippagePct, initialCapital } = cfg.backtest;
  const ind = computeIndicators(candles, cfg.strategy);
  let cash = initialCapital;
  let pos: Position | undefined;
  let barsInMarket = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: BacktestResult['equityCurve'] = [];

  const close = (c: Candle, rawPrice: number, reason: string) => {
    const p = pos!;
    const price = rawPrice * (1 - slippagePct);
    const proceeds = p.qty * price;
    const exitCost = proceeds * costPct;
    cash += proceeds - exitCost;
    const pnl = (price - p.entryPrice) * p.qty - p.entryCost - exitCost;
    trades.push({
      entryTime: p.entryTime,
      exitTime: c.time,
      entryPrice: p.entryPrice,
      exitPrice: price,
      qty: p.qty,
      pnl,
      rMultiple: pnl / ((p.entryPrice - p.initialStop) * p.qty),
      exitReason: reason,
    });
    pos = undefined;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;

    if (pos) {
      barsInMarket++;
      if (c.low <= pos.stop) {
        close(c, Math.min(c.open, pos.stop), 'stop hit');
      } else {
        const d = exitSignal(candles, ind, i, pos, cfg.strategy);
        if (d.exit) close(c, c.close, d.reason);
        else {
          pos.stop = d.stop;
          pos.highestClose = d.highestClose;
        }
      }
    }

    if (!pos && i < candles.length - 1) {
      const e = entrySignal(candles, ind, i, cfg.strategy);
      if (e.enter) {
        const price = c.close * (1 + slippagePct);
        const equity = cash;
        const { qty } = positionSize({ equity, cash: cash / (1 + costPct), price, stop: e.stop }, cfg.risk);
        if (qty > 0) {
          const entryCost = qty * price * costPct;
          cash -= qty * price + entryCost;
          pos = { qty, entryPrice: price, entryTime: c.time, initialStop: e.stop, stop: e.stop, highestClose: c.close, entryCost };
        }
      }
    }

    equityCurve.push({ time: c.time, equity: cash + (pos ? pos.qty * c.close : 0) });
  }

  const last = candles.at(-1);
  if (pos && last) {
    close(last, last.close, 'end of data');
    equityCurve[equityCurve.length - 1] = { time: last.time, equity: cash };
  }

  return { symbol, trades, equityCurve, metrics: computeMetrics(initialCapital, equityCurve, trades, barsInMarket) };
}

export function computeMetrics(
  startEquity: number,
  curve: { time: Date; equity: number }[],
  trades: BacktestTrade[],
  barsInMarket: number,
): Metrics {
  const endEquity = curve.at(-1)?.equity ?? startEquity;
  const years = curve.length > 1 ? (curve.at(-1)!.time.getTime() - curve[0]!.time.getTime()) / (365.25 * 86_400_000) : 0;

  let peak = startEquity;
  let maxDrawdown = 0;
  const rets: number[] = [];
  let prev = startEquity;
  for (const { equity } of curve) {
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    rets.push(equity / prev - 1);
    prev = equity;
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(rets.length - 1, 1));

  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);

  return {
    startEquity,
    endEquity,
    totalReturn: endEquity / startEquity - 1,
    cagr: years > 0 ? (endEquity / startEquity) ** (1 / years) - 1 : 0,
    maxDrawdown,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgR: trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0,
    exposure: curve.length ? barsInMarket / curve.length : 0,
  };
}
