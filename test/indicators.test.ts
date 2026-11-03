import { describe, expect, it } from 'vitest';
import { toChartCandles } from '../src/server/routes';
import { atr, bollinger, ema, heikinAshi, macd, rsi, sma, supertrend, vwap, type Bar } from '../web/src/lib/indicators';

const bar = (time: number | string, close: number, extra: Partial<Bar> = {}): Bar => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 100, ...extra });

describe('chart indicators', () => {
  it('SMA and EMA (EMA seeded with the SMA)', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });

  it('RSI with Wilder smoothing, hand-checked', () => {
    expect(rsi([1, 2, 1, 2, 1], 2)).toEqual([null, null, 50, 75, 37.5]);
    expect(rsi([1, 2, 3, 4, 5, 6], 3).at(-1)).toBe(100);
    expect(rsi([6, 5, 4, 3, 2, 1], 3).at(-1)).toBe(0);
  });

  it('Bollinger bands collapse on a flat series and widen with volatility', () => {
    const flat = bollinger([5, 5, 5, 5], 2, 2);
    expect(flat.upper.at(-1)).toBe(5);
    expect(flat.lower.at(-1)).toBe(5);
    const b = bollinger([1, 3], 2, 2); // mean 2, population sd 1
    expect([b.lower[1], b.mid[1], b.upper[1]]).toEqual([0, 2, 4]);
  });

  it('MACD = EMA12 - EMA26, signal = EMA9 of MACD, histogram = difference', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.3);
    const m = macd(closes);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    expect(m.macd[24]).toBeNull();
    expect(m.macd[25]).toBeCloseTo(e12[25]! - e26[25]!, 10);
    expect(m.signal[32]).toBeNull();
    expect(m.signal[33]).not.toBeNull();
    expect(m.hist[59]).toBeCloseTo(m.macd[59]! - m.signal[59]!, 10);
  });

  it('VWAP resets each day', () => {
    const day = 86_400;
    const bars = [bar(day + 100, 10, { high: 10, low: 10, volume: 1 }), bar(day + 200, 20, { high: 20, low: 20, volume: 3 }), bar(2 * day + 100, 50, { high: 50, low: 50, volume: 2 })];
    expect(vwap(bars)).toEqual([10, 17.5, 50]);
  });

  it('Heikin-Ashi, ATR and Supertrend behave on a steady uptrend', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i * 2, { open: 99 + i * 2, high: 101 + i * 2, low: 98 + i * 2 }));
    const ha = heikinAshi(bars);
    expect(ha[0]).toMatchObject({ open: (99 + 100) / 2, close: (99 + 101 + 98 + 100) / 4 });
    expect(atr(bars, 14)[12]).toBeNull();
    expect(atr(bars, 14)[13]).toBeGreaterThan(0);
    const st = supertrend(bars, 10, 3);
    expect(st.dir.at(-1)).toBe(1);
    expect(st.value.at(-1)!).toBeLessThan(bars.at(-1)!.close);
  });
});

describe('chart candles from the provider', () => {
  const c = (iso: string, close: number) => ({ time: new Date(iso), open: close, high: close, low: close, close, volume: 1 });
  it('shifts intraday times to IST, sorts, de-duplicates, and keeps only the last session for 1D', () => {
    const rows = [c('2026-11-03T09:45:00Z', 3), c('2026-11-02T03:45:00Z', 1), c('2026-11-03T03:45:00Z', 2), c('2026-11-03T09:45:00Z', 4)];
    const all = toChartCandles(rows, true, '5D');
    expect(all.map((x) => x.close)).toEqual([1, 2, 4]); // the duplicate keeps the later row
    expect(all[0]!.time).toBe(Date.parse('2026-11-02T03:45:00Z') / 1000 + 19_800); // 09:15 IST shown as 09:15
    expect(toChartCandles(rows, true, '1D').map((x) => x.close)).toEqual([2, 4]);
  });
  it('uses IST calendar dates for daily candles', () => {
    expect(toChartCandles([c('2026-11-02T22:00:00Z', 7)], false, '1Y')[0]!.time).toBe('2026-11-03');
  });
});
