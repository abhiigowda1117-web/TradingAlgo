import type { RiskConfig, StrategyConfig } from '../config';
import type { Candle } from '../types';
import { istParts } from '../util/time';
import { affordableValue, approxCostPct, tradeCosts, type CostSchedule } from './costs';
import { positionSize } from './risk';
import { computeIndicators, entrySignal, exitSignal, type Indicators } from './strategy';

/** IST trading day of a candle, "YYYY-MM-DD". */
export const dayKey = (d: Date) => istParts(d).date;

export interface PortfolioOptions {
  strategy: StrategyConfig;
  risk: RiskConfig;
  costs: CostSchedule;
  /** Adverse slippage on every fill, as a fraction of price. */
  slippagePct: number;
  initialCapital: number;
  /** Evaluation window, inclusive, "YYYY-MM-DD". Earlier candles are used only to warm up indicators. */
  start: string;
  end: string;
  /** Point-in-time universe membership. A symbol may only be bought on days it returns true. Default: always. */
  isEligible?: (symbol: string, day: string) => boolean;
  /** Sale proceeds usable from the next session (T+1 credit). Default true. */
  settleNextSession?: boolean;
  /** Sell open positions at the final close (as trades). Default false: report them as open. */
  liquidateAtEnd?: boolean;
}

export interface PortfolioTrade {
  symbol: string;
  entryDay: string;
  exitDay: string;
  qty: number;
  /** Fill prices including slippage. */
  entryPrice: number;
  exitPrice: number;
  initialStop: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  exitReason: string;
}

export interface OpenPosition {
  symbol: string;
  entryDay: string;
  qty: number;
  entryPrice: number;
  lastPrice: number;
  stop: number;
  entryCosts: number;
  unrealizedPnl: number;
  exitPending?: string;
}

export interface DayRecord {
  day: string;
  equity: number;
  cash: number;
  unsettled: number;
  invested: number;
  positions: number;
}

export interface SkippedEntry {
  day: string;
  symbol: string;
  reason: string;
}

export interface PortfolioResult {
  calendar: string[];
  curve: DayRecord[];
  trades: PortfolioTrade[];
  open: OpenPosition[];
  skipped: SkippedEntry[];
  costs: { total: number; stt: number; stamp: number; exchangeSebiGst: number; brokerage: number; dp: number; slippage: number };
  /** Equity if every open position were sold at the final close, after slippage and selling costs. */
  liquidationValue: number;
}

interface Pos {
  symbol: string;
  qty: number;
  entryDay: string;
  entryPrice: number;
  entryCosts: number;
  initialStop: number;
  stop: number;
  highestClose: number;
  lastClose: number;
}

interface SymbolData {
  symbol: string;
  candles: Candle[];
  ind: Indicators;
  byDay: Map<string, number>;
}

/**
 * Long-only daily portfolio backtest with one shared cash balance.
 *
 * Timeline for each trading day:
 *  open    - settle yesterday's sale proceeds (T+1); execute exits signalled at yesterday's close;
 *            sell positions that open at or below their stop (gap); execute entries signalled at
 *            yesterday's close, in alphabetical order, within the position limit, risk limits and
 *            settled cash. An entry whose open is at or below its planned stop is skipped.
 *  session - positions whose low reaches their stop are sold at the stop.
 *  close   - evaluate exit signals and trail stops (effective tomorrow); evaluate entry signals for
 *            tomorrow's open; mark positions to the close.
 * A signal computed from a candle is never filled at that same candle's prices.
 */
export function runPortfolioBacktest(candles: Record<string, Candle[]>, o: PortfolioOptions): PortfolioResult {
  const settleNext = o.settleNextSession ?? true;
  const eligible = o.isEligible ?? (() => true);
  const sizingCosts = { costPct: approxCostPct(o.costs), slippagePct: o.slippagePct, stopBufferPct: 0 };

  const data: SymbolData[] = Object.keys(candles)
    .sort()
    .map((symbol) => {
      const c = candles[symbol]!;
      return { symbol, candles: c, ind: computeIndicators(c, o.strategy), byDay: new Map(c.map((x, i) => [dayKey(x.time), i])) };
    });
  const bySymbol = new Map(data.map((d) => [d.symbol, d]));
  const calendar = [...new Set(data.flatMap((d) => [...d.byDay.keys()]))].filter((k) => k >= o.start && k <= o.end).sort();

  let cash = o.initialCapital;
  let unsettled = 0;
  const positions = new Map<string, Pos>();
  const pendingExits = new Map<string, string>();
  let pendingEntries: { symbol: string; stop: number }[] = [];
  const trades: PortfolioTrade[] = [];
  const skipped: SkippedEntry[] = [];
  const curve: DayRecord[] = [];
  const costs = { total: 0, stt: 0, stamp: 0, exchangeSebiGst: 0, brokerage: 0, dp: 0, slippage: 0 };

  const bar = (symbol: string, day: string): { c: Candle; i: number } | undefined => {
    const d = bySymbol.get(symbol)!;
    const i = d.byDay.get(day);
    return i === undefined ? undefined : { c: d.candles[i]!, i };
  };

  const charge = (side: 'BUY' | 'SELL', value: number, rawPrice: number, qty: number) => {
    const b = tradeCosts(side, value, o.costs);
    costs.total += b.total;
    costs.stt += b.stt;
    costs.stamp += b.stamp;
    costs.exchangeSebiGst += b.exchange + b.sebi + b.gst;
    costs.brokerage += b.brokerage;
    costs.dp += b.dp;
    costs.slippage += Math.abs(value - rawPrice * qty);
    return b.total;
  };

  const sell = (p: Pos, rawPrice: number, day: string, reason: string) => {
    const price = rawPrice * (1 - o.slippagePct);
    const value = p.qty * price;
    const sellCosts = charge('SELL', value, rawPrice, p.qty);
    if (settleNext) unsettled += value - sellCosts;
    else cash += value - sellCosts;
    const grossPnl = (price - p.entryPrice) * p.qty;
    const total = p.entryCosts + sellCosts;
    trades.push({ symbol: p.symbol, entryDay: p.entryDay, exitDay: day, qty: p.qty, entryPrice: p.entryPrice, exitPrice: price, initialStop: p.initialStop, grossPnl, costs: total, netPnl: grossPnl - total, exitReason: reason });
    positions.delete(p.symbol);
    pendingExits.delete(p.symbol);
  };

  const marked = () => [...positions.values()].reduce((a, p) => a + p.qty * p.lastClose, 0);

  for (const day of calendar) {
    // ---- open
    cash += unsettled;
    unsettled = 0;

    for (const [symbol, reason] of [...pendingExits]) {
      const p = positions.get(symbol);
      const b = bar(symbol, day);
      if (!p) pendingExits.delete(symbol);
      else if (b) sell(p, b.c.open, day, reason); // no bar (suspended / no data): try again next session
    }
    for (const p of [...positions.values()]) {
      const b = bar(p.symbol, day);
      if (b && b.c.open <= p.stop) sell(p, b.c.open, day, 'stop (gap at open)');
    }

    for (const sig of pendingEntries) {
      const b = bar(sig.symbol, day);
      const skip = (reason: string) => skipped.push({ day, symbol: sig.symbol, reason });
      if (positions.has(sig.symbol)) continue;
      if (positions.size >= o.risk.maxOpenPositions) {
        skip('position limit');
        continue;
      }
      if (!b) {
        skip('no trading session');
        continue;
      }
      const open = b.c.open;
      if (open <= sig.stop) {
        skip('opened at or below the planned stop');
        continue;
      }
      const invested = marked();
      const equity = cash + unsettled + invested;
      const size = positionSize({ equity, cash, price: open, stop: sig.stop, exposure: invested }, o.risk, sizingCosts);
      const price = open * (1 + o.slippagePct);
      // Never spend more than settled cash, including this order's own costs.
      const qty = Math.min(size.qty, Math.floor(affordableValue(cash, o.costs) / price));
      if (qty < 1) {
        skip(size.qty < 1 ? size.reason : 'insufficient settled cash');
        continue;
      }
      const value = qty * price;
      const entryCosts = charge('BUY', value, open, qty);
      cash -= value + entryCosts;
      positions.set(sig.symbol, { symbol: sig.symbol, qty, entryDay: day, entryPrice: price, entryCosts, initialStop: sig.stop, stop: sig.stop, highestClose: b.c.close, lastClose: price });
    }
    pendingEntries = [];

    // ---- session: stops
    for (const p of [...positions.values()]) {
      const b = bar(p.symbol, day);
      if (b && b.c.low <= p.stop) sell(p, p.stop, day, 'stop');
    }

    // ---- close
    for (const p of positions.values()) {
      const b = bar(p.symbol, day);
      if (!b) continue;
      p.lastClose = b.c.close;
      const d = bySymbol.get(p.symbol)!;
      const x = exitSignal(d.candles, d.ind, b.i, p, o.strategy);
      if (x.exit) pendingExits.set(p.symbol, x.reason);
      else {
        p.stop = x.stop;
        p.highestClose = x.highestClose;
      }
    }
    for (const d of data) {
      if (positions.has(d.symbol) || !eligible(d.symbol, day)) continue;
      const i = d.byDay.get(day);
      if (i === undefined) continue;
      const e = entrySignal(d.candles, d.ind, i, o.strategy);
      if (e.enter) pendingEntries.push({ symbol: d.symbol, stop: e.stop }); // `data` is alphabetical
    }

    const invested = marked();
    curve.push({ day, equity: cash + unsettled + invested, cash, unsettled, invested, positions: positions.size });
  }

  const lastDay = calendar.at(-1);
  if (o.liquidateAtEnd && lastDay) {
    for (const p of [...positions.values()]) sell(p, p.lastClose, lastDay, 'end of test');
    cash += unsettled;
    unsettled = 0;
    const last = curve.at(-1);
    if (last) Object.assign(last, { equity: cash, cash, unsettled: 0, invested: 0, positions: 0 });
  }

  const open: OpenPosition[] = [...positions.values()].map((p) => ({
    symbol: p.symbol,
    entryDay: p.entryDay,
    qty: p.qty,
    entryPrice: p.entryPrice,
    lastPrice: p.lastClose,
    stop: p.stop,
    entryCosts: p.entryCosts,
    unrealizedPnl: (p.lastClose - p.entryPrice) * p.qty - p.entryCosts,
    exitPending: pendingExits.get(p.symbol),
  }));
  const liquidationValue =
    cash +
    unsettled +
    open.reduce((a, p) => {
      const value = p.qty * p.lastPrice * (1 - o.slippagePct);
      return a + value - tradeCosts('SELL', value, o.costs).total;
    }, 0);

  return { calendar, curve, trades, open, skipped, costs, liquidationValue };
}
