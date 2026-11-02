import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { membershipFilter, readConstituents } from '../src/data/constituents';
import { readSeriesCsv } from '../src/data/csv';
import { alignBenchmark, buyAndHold } from '../src/trading/benchmark';
import { tradeCosts } from '../src/trading/costs';
import { summarizeCurve, summarizeStrategy } from '../src/trading/performance';
import { dayKey, runPortfolioBacktest, type PortfolioOptions } from '../src/trading/portfolioBacktest';
import { computeIndicators, entrySignal } from '../src/trading/strategy';
import type { Candle } from '../src/types';
import { syntheticCandles, tradingCfg } from './helpers';

// The seed-1 synthetic series gives an entry signal at the close of bar 234.
const SIGNAL = 234;
const base = syntheticCandles(800, { seed: 1 });
const day = (i: number) => dayKey(base[i]!.time);
const scale = (c: Candle[], k: number) => c.map((x) => ({ ...x, open: x.open * k, high: x.high * k, low: x.low * k, close: x.close * k }));
const signalStop = (() => {
  const e = entrySignal(base, computeIndicators(base, tradingCfg.strategy), SIGNAL, tradingCfg.strategy);
  if (!e.enter) throw new Error('fixture: expected an entry signal at bar 234');
  return e.stop;
})();

const costs = tradingCfg.backtest.costs;
const opts = (o: Partial<PortfolioOptions> = {}): PortfolioOptions => ({
  strategy: tradingCfg.strategy,
  risk: tradingCfg.risk,
  costs,
  slippagePct: 0.0005,
  initialCapital: 500_000,
  start: day(220),
  end: day(260),
  ...o,
});

/** n symbols with identical (scaled) price paths, so they all signal on the same day. */
const many = (n: number, k = 1) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String.fromCharCode(65 + i), scale(base, k)]));

describe('portfolio backtest: execution timing', () => {
  it('fills a signal at the NEXT session open, never at the signal candle', () => {
    const r = runPortfolioBacktest({ A: base }, opts());
    const t = r.trades[0] ?? r.open[0]!;
    expect(t.entryDay).toBe(day(SIGNAL + 1));
    expect(t.entryPrice).toBeCloseTo(base[SIGNAL + 1]!.open * 1.0005, 6);
    expect(t.entryPrice).not.toBeCloseTo(base[SIGNAL]!.close * 1.0005, 6);
  });

  it('skips an entry whose next open is at or below the planned stop', () => {
    const c = base.map((x, i) => (i === SIGNAL + 1 ? { ...x, open: signalStop - 1, low: signalStop - 2 } : x));
    const r = runPortfolioBacktest({ A: c }, opts());
    expect(r.trades.concat().length + r.open.length).toBe(0);
    expect(r.skipped[0]).toMatchObject({ symbol: 'A', day: day(SIGNAL + 1), reason: expect.stringMatching(/below the planned stop/) });
  });
});

describe('portfolio backtest: stop-loss and gaps', () => {
  const entered = (c: Candle[]) => runPortfolioBacktest({ A: c }, opts());

  it('sells at the open when the price gaps below the stop', () => {
    const k = SIGNAL + 3;
    const c = base.map((x, i) => (i === k ? { ...x, open: signalStop * 0.95, high: signalStop * 0.96, low: signalStop * 0.94, close: signalStop * 0.95 } : x));
    const t = entered(c).trades[0]!;
    expect(t.exitDay).toBe(day(k));
    expect(t.exitReason).toBe('stop (gap at open)');
    expect(t.exitPrice).toBeCloseTo(signalStop * 0.95 * (1 - 0.0005), 6);
  });

  it('sells at the stop when the low touches it during the session', () => {
    const k = SIGNAL + 3;
    const c = base.map((x, i) => (i === k ? { ...x, open: signalStop * 1.02, high: signalStop * 1.03, low: signalStop * 0.99 } : x));
    const t = entered(c).trades[0]!;
    expect(t.exitDay).toBe(day(k));
    expect(t.exitReason).toBe('stop');
    expect(t.exitPrice).toBeCloseTo(signalStop * (1 - 0.0005), 6);
  });
});

describe('portfolio backtest: shared capital', () => {
  it('allocates one cash pool across simultaneous entries and never goes negative', () => {
    const r = runPortfolioBacktest(many(3), opts());
    const entryDay = r.curve.find((p) => p.day === day(SIGNAL + 1))!;
    expect(entryDay.positions).toBe(3);
    const bought = r.trades.concat().length === 0 ? r.open : r.open; // all still open in this window
    const spent = bought.reduce((a, p) => a + p.qty * p.entryPrice + p.entryCosts, 0);
    expect(entryDay.cash).toBeCloseTo(500_000 - spent, 2);
    for (const p of r.curve) {
      expect(p.cash).toBeGreaterThanOrEqual(-1e-6);
      expect(p.equity).toBeCloseTo(p.cash + p.unsettled + p.invested, 6);
    }
  });

  // 15% per position so five fit under the 80% exposure cap; the position limit is what binds.
  const fivePositionRisk = { ...tradingCfg.risk, maxPositionPct: 0.15 };

  it('enforces the five-position limit', () => {
    const r = runPortfolioBacktest(many(7), opts({ risk: fivePositionRisk }));
    expect(Math.max(...r.curve.map((p) => p.positions))).toBe(5);
    const limited = r.skipped.filter((s) => s.reason === 'position limit');
    expect(limited.map((s) => s.symbol)).toEqual(['F', 'G']);
  });

  it('handles simultaneous signals deterministically (alphabetical), whatever the input order', () => {
    const a = runPortfolioBacktest(many(7), opts({ risk: fivePositionRisk }));
    const reversed = Object.fromEntries(Object.entries(many(7)).reverse());
    const b = runPortfolioBacktest(reversed, opts({ risk: fivePositionRisk }));
    expect(a.open.map((p) => p.symbol)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(b.open.map((p) => p.symbol)).toEqual(a.open.map((p) => p.symbol));
    expect(b.curve.at(-1)!.equity).toBeCloseTo(a.curve.at(-1)!.equity, 6);
  });

  it('shrinks the order that exhausts cash and skips the rest', () => {
    const risk = { ...tradingCfg.risk, riskPerTrade: 0.05, maxPositionPct: 1, maxTotalExposurePct: 1 };
    const r = runPortfolioBacktest(many(5), opts({ initialCapital: 30_000, risk }));
    expect(r.open).toHaveLength(1); // A takes (almost) all the cash
    const a = r.open[0]!;
    expect(a.qty * a.entryPrice + a.entryCosts).toBeLessThanOrEqual(30_000);
    // With the money spent, the cash and total-exposure limits bind together; sizing reports the first.
    const skips = r.skipped.filter((s) => /cash|exposure/.test(s.reason)).map((s) => s.symbol);
    expect(skips).toEqual(['B', 'C', 'D', 'E']);
    const entryDay = r.curve.find((p) => p.day === a.entryDay)!;
    expect(entryDay.cash).toBeLessThan(a.entryPrice); // not enough left for even one more share
    for (const p of r.curve) expect(p.cash).toBeGreaterThanOrEqual(-1e-6);
  });

  it('does not reuse sale proceeds in the same session (T+1 settlement)', () => {
    const k = SIGNAL + 3; // forced gap-down sale on this day
    const c = base.map((x, i) => (i === k ? { ...x, open: signalStop * 0.95, high: signalStop * 0.96, low: signalStop * 0.94, close: signalStop * 0.95 } : x));
    const r = runPortfolioBacktest({ A: c }, opts());
    const sale = r.curve.findIndex((p) => p.day === day(k));
    expect(r.trades[0]!.exitDay).toBe(day(k));
    expect(r.curve[sale]!.unsettled).toBeGreaterThan(0);
    expect(r.curve[sale]!.cash).toBeCloseTo(r.curve[sale - 1]!.cash, 6); // not spendable yet
    expect(r.curve[sale + 1]!.unsettled).toBe(0);
    expect(r.curve[sale + 1]!.cash).toBeCloseTo(r.curve[sale]!.cash + r.curve[sale]!.unsettled, 6);

    const sameDay = runPortfolioBacktest({ A: c }, opts({ settleNextSession: false }));
    expect(sameDay.curve[sale]!.unsettled).toBe(0);
  });
});

describe('portfolio backtest: position sizing and risk limits', () => {
  it('respects risk per trade, position size, order value and total exposure', () => {
    const r = runPortfolioBacktest(many(5, 10), opts()); // price ~₹1,200
    const entryDay = r.curve.find((p) => p.day === day(SIGNAL + 1))!;
    let exposure = 0;
    for (const p of r.open) {
      const value = p.qty * p.entryPrice;
      exposure += value;
      expect(value).toBeLessThanOrEqual(500_000 * tradingCfg.risk.maxPositionPct * 1.001);
      expect(value).toBeLessThanOrEqual(tradingCfg.risk.maxOrderValue * 1.001);
      expect((p.entryPrice - signalStop * 10) * p.qty).toBeLessThanOrEqual(500_000 * tradingCfg.risk.riskPerTrade);
    }
    expect(exposure).toBeLessThanOrEqual(500_000 * tradingCfg.risk.maxTotalExposurePct * 1.001);
    expect(entryDay.invested).toBeGreaterThan(0);
  });

  it('only buys stocks that were index members on the signal day', () => {
    const eligible = membershipFilter([{ symbol: 'A', from: day(0), to: day(SIGNAL - 1) }, { symbol: 'B', from: day(0) }]);
    const r = runPortfolioBacktest(many(2), opts({ isEligible: eligible }));
    expect(r.open.map((p) => p.symbol)).toEqual(['B']);
  });
});

describe('portfolio backtest: transaction costs', () => {
  it('itemises Indian delivery charges', () => {
    const buy = tradeCosts('BUY', 100_000, costs);
    expect(buy.stt).toBeCloseTo(100, 6);
    expect(buy.stamp).toBeCloseTo(15, 6);
    expect(buy.exchange).toBeCloseTo(2.97, 6);
    expect(buy.gst).toBeCloseTo((2.97 + 0.1) * 0.18, 6);
    expect(buy.dp).toBe(0);
    const sell = tradeCosts('SELL', 100_000, costs);
    expect(sell.stamp).toBe(0);
    expect(sell.dp).toBe(15.93);
    expect(tradeCosts('BUY', 0, costs).total).toBe(0);
  });

  it('reconciles: final equity = capital + net P&L of all trades, and net = gross - costs', () => {
    const r = runPortfolioBacktest(many(3), opts({ end: day(799), liquidateAtEnd: true }));
    expect(r.trades.length).toBeGreaterThan(3);
    for (const t of r.trades) expect(t.netPnl).toBeCloseTo(t.grossPnl - t.costs, 6);
    const net = r.trades.reduce((a, t) => a + t.netPnl, 0);
    expect(r.curve.at(-1)!.equity).toBeCloseTo(500_000 + net, 4);
    expect(r.costs.total).toBeCloseTo(r.trades.reduce((a, t) => a + t.costs, 0), 4);
    expect(r.costs.stt).toBeGreaterThan(0);
  });

  it('charges both the buy side and the sell side on every closed trade', () => {
    const r = runPortfolioBacktest(many(1), opts({ end: day(799), liquidateAtEnd: true }));
    for (const t of r.trades) {
      const expected = tradeCosts('BUY', t.qty * t.entryPrice, costs).total + tradeCosts('SELL', t.qty * t.exitPrice, costs).total;
      expect(t.costs).toBeCloseTo(expected, 6);
    }
  });
});

describe('portfolio backtest: open positions at the end', () => {
  it('reports open positions, marks them in equity, and shows the value after selling costs', () => {
    const r = runPortfolioBacktest(many(2), opts());
    expect(r.open).toHaveLength(2);
    const last = r.curve.at(-1)!;
    expect(last.invested).toBeCloseTo(r.open.reduce((a, p) => a + p.qty * p.lastPrice, 0), 6);
    expect(r.liquidationValue).toBeLessThan(last.equity);
    expect(r.liquidationValue).toBeGreaterThan(last.equity * 0.99);
  });

  it('can liquidate at the end instead, booking them as trades', () => {
    const r = runPortfolioBacktest(many(2), opts({ liquidateAtEnd: true }));
    expect(r.open).toHaveLength(0);
    expect(r.trades.filter((t) => t.exitReason === 'end of test')).toHaveLength(2);
    expect(r.curve.at(-1)!.invested).toBe(0);
  });
});

describe('benchmark', () => {
  const cal = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'];
  const series = (days: string[], start = 100) => days.map((d, i) => ({ time: new Date(`${d}T00:00:00Z`), open: start + i, high: start + i, low: start + i, close: start + i, volume: 0 }));

  it('aligns to the strategy calendar, forward-filling and counting missing days', () => {
    const a = alignBenchmark(cal, series(['2023-12-29', '2024-01-01', '2024-01-03', '2024-01-04']), 0.5);
    expect(a.values).toEqual([101, 101, 102, 103]);
    expect(a.filledDays).toEqual(['2024-01-02']);
  });

  it('rejects a benchmark that starts after the test or has too many gaps', () => {
    expect(() => alignBenchmark(cal, series(['2024-01-02', '2024-01-03']))).toThrow(/no data on or before/);
    expect(() => alignBenchmark(cal, series(['2024-01-01', '2024-01-04']), 0.02)).toThrow(/missing 2 of 4/);
  });

  it('buys and holds with the same capital, costs and calendar', () => {
    const b = buyAndHold(cal, [100, 101, 102, 110], 500_000, costs, 0.0005);
    expect(b.curve.map((p) => p.day)).toEqual(cal);
    expect(b.curve[0]!.equity).toBeLessThan(500_000);
    expect(b.curve[0]!.equity).toBeGreaterThan(500_000 * 0.997);
    expect(b.curve.at(-1)!.equity / b.curve[0]!.equity).toBeCloseTo(1.1, 2);
    expect(b.liquidationValue).toBeLessThan(b.curve.at(-1)!.equity);
  });

  it('lines up exactly with the strategy curve', () => {
    const r = runPortfolioBacktest(many(1), opts());
    const nifty = scale(base, 200);
    const a = alignBenchmark(r.calendar, nifty);
    const b = buyAndHold(r.calendar, a.values, 500_000, costs, 0.0005);
    expect(b.curve.map((p) => p.day)).toEqual(r.curve.map((p) => p.day));
    expect(a.filledDays).toHaveLength(0);
  });
});

describe('performance summaries', () => {
  it('chains sub-periods: train and test returns compound to the full-period return', () => {
    const r = runPortfolioBacktest(many(3), opts({ end: day(799) }));
    const first = r.calendar[0]!;
    const last = r.calendar.at(-1)!;
    const mid = r.calendar[Math.floor(r.calendar.length / 2)]!;
    const prev = r.calendar[r.calendar.indexOf(mid) - 1]!;
    const full = summarizeStrategy(r, first, last, 500_000);
    const train = summarizeStrategy(r, first, prev, 500_000);
    const test = summarizeStrategy(r, mid, last);
    expect((1 + train.totalReturn) * (1 + test.totalReturn)).toBeCloseTo(1 + full.totalReturn, 8);
    expect(full.trades).toBe(train.trades! + test.trades!);
    expect(full.exposure).toBeGreaterThan(0);
    expect(full.cashUtilization).toBeGreaterThan(0);
    expect(full.cashUtilization).toBeLessThanOrEqual(1);
  });

  it('computes drawdown and returns from a curve', () => {
    const s = summarizeCurve('x', [{ day: 'a', equity: 100 }, { day: 'b', equity: 120 }, { day: 'c', equity: 90 }, { day: 'd', equity: 110 }], 'a', 'd', 100);
    expect(s.totalReturn).toBeCloseTo(0.1);
    expect(s.maxDrawdown).toBeCloseTo(0.25);
  });
});

describe('data files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));

  it('reads point-in-time constituents', () => {
    const p = join(dir, 'members.csv');
    writeFileSync(p, 'symbol,from,to\nINFY,2010-01-01,\nYESBANK,2015-03-01,2020-03-19\n');
    const f = membershipFilter(readConstituents(p));
    expect(f('YESBANK', '2019-01-01')).toBe(true);
    expect(f('YESBANK', '2021-01-01')).toBe(false);
    expect(f('INFY', '2026-01-01')).toBe(true);
    expect(f('TCS', '2026-01-01')).toBe(false);
  });

  it('reads an NSE-style TRI download (quoted, DD Mon YYYY dates)', () => {
    const p = join(dir, 'tri.csv');
    writeFileSync(p, '﻿"Date","Total Returns Index"\n"02 Jan 2024","32,000.50"\n"01 Jan 2024","31,900.25"\n');
    const s = readSeriesCsv(p);
    expect(s.map((c) => dayKey(c.time))).toEqual(['2024-01-01', '2024-01-02']);
    expect(s[1]!.close).toBe(32000.5);
  });
});
