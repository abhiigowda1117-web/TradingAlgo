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

describe('strategy', () => {
  const candles = syntheticCandles(800, { seed: 1 });
  const ind = computeIndicators(candles, tradingCfg.strategy);

  it('enters on a bullish crossover above the trend with RSI in band, stop 2 ATR below', () => {
    const e = entrySignal(candles, ind, 234, tradingCfg.strategy);
    expect(e.enter).toBe(true);
    if (e.enter) expect(e.stop).toBeCloseTo(candles[234]!.close - 2 * ind.atr[234]!);
  });

  it('does not enter before indicators are warmed up or without a crossover', () => {
    expect(entrySignal(candles, ind, 100, tradingCfg.strategy).enter).toBe(false);
    expect(entrySignal(candles, ind, 235, tradingCfg.strategy).enter).toBe(false);
  });

  it('trailing stop only ratchets up', () => {
    const d = exitSignal(candles, ind, 240, { stop: 1e9, highestClose: 0 }, tradingCfg.strategy);
    if (!d.exit) expect(d.stop).toBe(1e9);
    const d2 = exitSignal(candles, ind, 240, { stop: 0, highestClose: 0 }, tradingCfg.strategy);
    if (!d2.exit) expect(d2.stop).toBeCloseTo(Math.max(candles[240]!.close) - 3 * ind.atr[240]!);
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
