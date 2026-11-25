import { describe, expect, it } from 'vitest';
import { backtest } from '../src/trading/backtest';
import { toTick } from '../src/trading/brokers/broker';
import { atr, ema, rsi } from '../src/trading/indicators';
import { dailyLossBreached, positionSize } from '../src/trading/risk';
import { computeIndicators, entrySignal, exitSignal } from '../src/trading/strategy';
import type { Candle } from '../src/types';
import { syntheticCandles, tradingCfg } from './helpers';

const bar = (close: number, range = 2): Candle => ({ time: new Date(), open: close, high: close + range / 2, low: close - range / 2, close, volume: 0 });

describe('indicators', () => {
  it('ema is seeded with the SMA and then smooths', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out[2]).toBe(2);
    expect(out[3]).toBe(3);
    expect(out[4]).toBe(4);
  });

  it('rsi is 100 for a series that only rises and 0 for one that only falls', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi(up.reverse(), 14).at(-1)).toBe(0);
  });

  it('atr equals the bar range when there are no gaps', () => {
    const out = atr(Array.from({ length: 20 }, () => bar(100, 4)), 14);
    expect(out[14]).toBeCloseTo(4);
    expect(out.at(-1)).toBeCloseTo(4);
  });
});

describe('strategy: EMA 5/48 + RSI + MACD (from the strategy document)', () => {
  const cfg = tradingCfg.strategy;
  /** A rising stock (1%/day, speeding up), then a small red dip, then the last bar as given. */
  function setup(last: 'green' | 'red', dip = true): Candle[] {
    const c: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 70; i++) {
      p *= 1.01 + i * 0.0001;
      c.push({ time: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000), open: p * 0.995, high: p * 1.01, low: p * 0.99, close: p, volume: 1e5 });
    }
    if (dip) {
      const d = p * 0.98;
      c.push({ time: new Date(Date.UTC(2026, 0, 1) + 70 * 86_400_000), open: p, high: p, low: d * 0.99, close: d, volume: 1e5 });
      p = d;
    }
    const close = last === 'green' ? p * 1.025 : p * 0.995;
    const open = last === 'green' ? p * 1.0 : p * 1.005;
    c.push({ time: new Date(Date.UTC(2026, 0, 1) + 71 * 86_400_000), open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.995, close, volume: 1e5 });
    return c;
  }
  const at = (c: Candle[]) => entrySignal(c, computeIndicators(c, cfg), c.length - 1, cfg);

  it('buys an uptrend after a small dip, once a green candle confirms; stop below the 5-day low', () => {
    const c = setup('green');
    const e = at(c);
    expect(e).toMatchObject({ enter: true, reason: expect.stringMatching(/EMA 5 > EMA 48.*green candle/) });
    const lowest5 = Math.min(...c.slice(-5).map((x) => x.low));
    if (e.enter) expect(e.stop).toBeCloseTo(Math.min(lowest5 * 0.999, c.at(-1)!.close * 0.995));
  });

  it('waits for the green candle and for the dip; never buys a downtrend', () => {
    expect(at(setup('red'))).toMatchObject({ enter: false, reason: 'no green confirmation candle' });
    expect(at(setup('green', false))).toMatchObject({ enter: false, reason: expect.stringMatching(/no small dip/) });
    const down = setup('green').map((x, i, a) => ({ ...a[a.length - 1 - i]!, time: x.time }));
    expect(at(down)).toMatchObject({ enter: false });
  });

  it('sells at the 1:2 target, when the trend turns, or when strength fades', () => {
    const c = setup('green');
    const ind = computeIndicators(c, cfg);
    const i = c.length - 1;
    const close = c[i]!.close;
    // Bought at 100 with a stop at 95: risk 5, target 110.
    expect(exitSignal(c, ind, i, { stop: 0, highestClose: 0, entryPrice: close / 1.11, initialStop: close / 1.11 - (close / 1.11) * 0.05 }, cfg)).toMatchObject({ exit: true, reason: 'target 1:2 reached' });
    expect(exitSignal(c, ind, i, { stop: 50, highestClose: 0, entryPrice: close, initialStop: close * 0.95 }, cfg)).toMatchObject({ exit: false, stop: 50 });
    const down = setup('green').map((x, k, a) => ({ ...a[a.length - 1 - k]!, time: x.time }));
    expect(exitSignal(down, computeIndicators(down, cfg), down.length - 1, { stop: 0, highestClose: 0 }, cfg)).toMatchObject({ exit: true });
  });

  it('an unknown or retired strategy name falls back to this strategy', () => {
    const c = setup('green');
    const old = { ...cfg, name: 'buyHold' as never };
    expect(entrySignal(c, computeIndicators(c, old), c.length - 1, old).enter).toBe(true);
  });
});

describe('risk', () => {
  const risk = tradingCfg.risk;

  it('sizes so that a stop-out loses riskPerTrade of equity', () => {
    // 1% of 10L = 10k risk, 50/share risk -> 200 shares; 200 * 1000 = 2L = 20% cap exactly.
    expect(positionSize({ equity: 1_000_000, cash: 1_000_000, price: 1000, stop: 950 }, risk)).toEqual({ qty: 200, reason: 'sized by risk limit' });
  });

  it('applies the tightest of the caps', () => {
    expect(positionSize({ equity: 1_000_000, cash: 50_000, price: 1000, stop: 950 }, risk).qty).toBe(50);
    expect(positionSize({ equity: 1_000_000, cash: 1_000_000, price: 1000, stop: 999 }, risk).qty).toBe(200);
    expect(positionSize({ equity: 5_000_000, cash: 5_000_000, price: 1000, stop: 900 }, risk).qty).toBe(200); // ₹2L order cap
  });

  it('rejects a stop at or above the price and sizes below one share', () => {
    expect(positionSize({ equity: 1e6, cash: 1e6, price: 100, stop: 100 }, risk).qty).toBe(0);
    expect(positionSize({ equity: 1e6, cash: 500, price: 1000, stop: 900 }, risk)).toEqual({ qty: 0, reason: 'cash limit allows less than 1 share' });
  });

  it('flags the daily loss limit', () => {
    expect(dailyLossBreached(100_000, 98_100, risk)).toBe(false);
    expect(dailyLossBreached(100_000, 98_000, risk)).toBe(true);
  });
});

describe('toTick', () => {
  it('rounds to a valid NSE tick for each price band', () => {
    expect(toTick(123.437)).toBe(123.45);
    expect(toTick(512.34)).toBe(512.3);
    expect(toTick(1534.27)).toBe(1534.5);
    expect(toTick(7123.6)).toBe(7124);
  });
});

describe('backtest', () => {
  const candles = syntheticCandles(800, { seed: 1 });
  const r = backtest('SYN', candles, tradingCfg);

  it('trades the synthetic cycles and books every trade', () => {
    expect(r.trades.length).toBeGreaterThanOrEqual(5);
    const pnl = r.trades.reduce((a, t) => a + t.pnl, 0);
    expect(r.metrics.endEquity).toBeCloseTo(tradingCfg.backtest.initialCapital + pnl, 2);
    expect(r.equityCurve).toHaveLength(candles.length);
  });

  it('never risks more than ~1% of equity at entry', () => {
    for (const t of r.trades) expect(t.rMultiple).toBeGreaterThan(-1.5);
  });

  it('reports sane metrics', () => {
    const m = r.metrics;
    expect(m.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(m.maxDrawdown).toBeLessThan(1);
    expect(m.winRate).toBeGreaterThanOrEqual(0);
    expect(m.winRate).toBeLessThanOrEqual(1);
    expect(m.exposure).toBeGreaterThan(0);
  });

  it('a flat market produces no trades', () => {
    const flat = Array.from({ length: 400 }, (_, i) => ({ ...bar(100), time: new Date(2020, 0, i + 1) }));
    expect(backtest('FLAT', flat, tradingCfg).trades).toHaveLength(0);
  });
});
