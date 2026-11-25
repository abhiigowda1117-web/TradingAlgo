import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregate, camarilla, camarillaSignal, fibSignal, IntradayDesk, intradaySettings, orbSignal, type IntradaySignal } from '../src/trading/intraday';
import type { Candle } from '../src/types';

const TODAY = '2026-11-24'; // Tuesday
/** A 5-minute bar starting at `hhmm` IST on `date`. */
function bar(date: string, hhmm: string, o: number, h: number, l: number, c: number): Candle {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return { time: new Date(Date.parse(`${date}T00:00:00Z`) + ((hh * 60 + mm) - 330) * 60_000), open: o, high: h, low: l, close: c, volume: 1000 };
}
const sig = (x: IntradaySignal | string) => {
  if (typeof x === 'string') throw new Error(`expected a signal, got: ${x}`);
  return x;
};

// ---------------------------------------------------------------- 9:30 opening range
const range = [bar(TODAY, '09:15', 100, 102, 99, 101), bar(TODAY, '09:20', 101, 101.5, 98, 99), bar(TODAY, '09:25', 99, 101, 98.5, 100.5)];

describe('9:30 opening range breakout', () => {
  it('buys the retest of the 9:15-9:30 high after a breakout; stop below the retest candle; 1:2 target', () => {
    const bars = [...range, bar(TODAY, '09:30', 100.5, 103.5, 100.4, 103.2), bar(TODAY, '09:35', 102.2, 103.0, 101.95, 102.9)];
    const s = sig(orbSignal(bars, TODAY));
    expect(s.side).toBe('long');
    expect(s.entry).toBe(102.9);
    expect(s.stop).toBeCloseTo(101.95 * 0.999);
    expect(s.target).toBeCloseTo(102.9 + 2 * (102.9 - s.stop));
  });

  it('sells short the failed retest of the low after a breakdown', () => {
    const bars = [...range, bar(TODAY, '09:30', 98.5, 98.6, 96.5, 96.8), bar(TODAY, '09:35', 97.9, 98.05, 97.2, 97.4)];
    const s = sig(orbSignal(bars, TODAY));
    expect(s.side).toBe('short');
    expect(s.stop).toBeGreaterThan(98);
    expect(s.target).toBeLessThan(s.entry);
  });

  it('no trade without a retest, before 9:30, or in the middle of the range', () => {
    expect(orbSignal([...range, bar(TODAY, '09:30', 100.5, 103.5, 100.4, 103.2), bar(TODAY, '09:35', 103.2, 105, 103.1, 104.8)], TODAY)).toMatch(/no break-and-retest/);
    expect(orbSignal(range.slice(0, 2), TODAY)).toMatch(/not complete/);
    expect(orbSignal([...range, bar(TODAY, '09:30', 100, 101, 99, 100.2), bar(TODAY, '09:35', 100.2, 101, 99.5, 100.6)], TODAY)).toMatch(/no break-and-retest/);
  });
});

// ---------------------------------------------------------------- Camarilla
describe('Camarilla pivots + 20 EMA', () => {
  // Yesterday: high 110, low 90, close 100 -> S3 = 94.5, R3 = 105.5.
  const yesterday = Array.from({ length: 75 }, (_, i) => {
    const t = `${String(9 + Math.floor((15 + i * 5) / 60)).padStart(2, '0')}:${String((15 + i * 5) % 60).padStart(2, '0')}`;
    return bar('2026-11-23', t, 100, i === 10 ? 110 : 100.5, i === 20 ? 90 : 99.5, 100);
  });
  const quiet = (level: number) =>
    Array.from({ length: 16 }, (_, i) => {
      const m = 15 + i * 5;
      return bar(TODAY, `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, level, level + 0.2, level - 0.2, level);
    });

  it('levels from the previous session', () => {
    expect(camarilla(110, 90, 100)).toEqual({ r3: 105.5, s3: 94.5, r4: 111, s4: 89 });
  });

  it('buys a strong green candle from S3 above the 20 EMA', () => {
    const bars = [...yesterday, ...quiet(95.6), bar(TODAY, '10:35', 94.6, 97.4, 94.3, 97.3)];
    const s = sig(camarillaSignal(bars, TODAY));
    expect(s).toMatchObject({ side: 'long', entry: 97.3 });
    expect(s.stop).toBeCloseTo(94.3 * 0.999);
    expect(s.reason).toMatch(/S3/);
  });

  it('sells short a strong red candle from R3 below the 20 EMA', () => {
    const bars = [...yesterday, ...quiet(104.6), bar(TODAY, '10:35', 105.4, 105.7, 102.7, 102.8)];
    expect(sig(camarillaSignal(bars, TODAY))).toMatchObject({ side: 'short', entry: 102.8 });
  });

  it('a weak candle at the level is not enough', () => {
    const bars = [...yesterday, ...quiet(95.6), bar(TODAY, '10:35', 95.0, 97.4, 94.3, 95.4)];
    expect(camarillaSignal(bars, TODAY)).toMatch(/no strong candle/);
  });
});

// ---------------------------------------------------------------- Fibonacci
/** 15-minute candles over several sessions, each split into three 5-minute bars. */
function fifteens(n: number, f: (i: number) => { o: number; h: number; l: number; c: number }) {
  const out: Candle[] = [];
  const days = ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24'];
  for (let i = 0; i < n; i++) {
    const start = Date.parse(`${days[Math.floor(i / 25)]}T03:45:00Z`) + (i % 25) * 15 * 60_000;
    const { o, h, l, c } = f(i);
    out.push({ time: new Date(start), open: o, high: h, low: l, close: o, volume: 1 });
    out.push({ time: new Date(start + 5 * 60_000), open: o, high: h, low: l, close: (o + c) / 2, volume: 1 });
    out.push({ time: new Date(start + 10 * 60_000), open: (o + c) / 2, high: h, low: l, close: c, volume: 1 });
  }
  return out;
}
/** Uptrend to a swing high, pullback to the 50% level near the 20 EMA, then a green confirmation candle. */
function fibUp() {
  const N = 60;
  const close = (i: number) => (i < 40 ? 100 + i * 0.4 : i <= 49 ? 115.6 + (i - 40) * 0.5 : i <= 52 ? 120.1 - (i - 49) * 1.0 : 117.3);
  return fifteens(N, (i) => {
    if (i === N - 1) return { o: 117.2, h: 118.4, l: 117.0, c: 118.3 };
    const c = close(i);
    const o = i <= 49 ? c - 0.3 : i <= 52 ? c + 0.6 : c;
    return { o, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, c };
  });
}

describe('Fibonacci + 20 EMA (15-minute)', () => {
  const bars = fibUp();
  const now = new Date(bars.at(-1)!.time.getTime() + 5 * 60_000);

  it('15-minute candles are built from 5-minute ones', () => {
    const b = aggregate(bars, 15);
    expect(b).toHaveLength(60);
    expect(b.at(-1)).toMatchObject({ open: 117.2, high: 118.4, low: 117.0, close: 118.3 });
  });

  it('buys only once the price goes above the confirmation candle; stop below the swing low; 1:2 target', () => {
    expect(fibSignal(bars, 118.3, now)).toMatch(/waiting for the price to go above ₹118\.40/);
    const s = sig(fibSignal(bars, 118.6, now));
    expect(s).toMatchObject({ side: 'long', entry: 118.6, trigger: 118.4 });
    expect(s.stop).toBeLessThan(116);
    expect(s.target).toBeCloseTo(118.6 + 2 * (118.6 - s.stop));
  });

  it('ignores an unfinished 15-minute candle', () => {
    const early = new Date(bars.at(-1)!.time.getTime() + 2 * 60_000);
    expect(typeof fibSignal(bars.slice(0, -1), 118.6, early)).toBe('string');
  });

  it('sells short the mirror image (downtrend, bounce, red candle)', () => {
    const mirror = bars.map((c) => ({ ...c, open: 240 - c.open, close: 240 - c.close, high: 240 - c.low, low: 240 - c.high }));
    const s = sig(fibSignal(mirror, 240 - 118.6, now));
    expect(s.side).toBe('short');
    expect(s.stop).toBeGreaterThan(124);
  });
});

// ---------------------------------------------------------------- the desk
function desk(o: { now: string; bars?: Candle[]; ltp?: Record<string, number>; kill?: 'off' | 'halt' | 'flatten'; symbols?: string[]; cfg?: Parameters<typeof intradaySettings>[0] }) {
  const dir = mkdtempSync(join(tmpdir(), 'intraday-'));
  const booked: { amount: number; note: string }[] = [];
  const trades: Record<string, unknown>[] = [];
  const env = { now: new Date(o.now), ltp: o.ltp ?? {}, kill: o.kill ?? 'off', bars: o.bars ?? [] };
  const d = new IntradayDesk({
    cfg: intradaySettings(o.cfg),
    stateFile: join(dir, 'intraday.json'),
    now: () => env.now,
    holidays: [],
    symbols: () => o.symbols ?? ['ABC'],
    candles5m: async () => env.bars,
    ltp: async (s) => Object.fromEntries(s.filter((x) => env.ltp[x] !== undefined).map((x) => [x, env.ltp[x]!])),
    equity: async () => 500_000,
    book: (amount, note) => booked.push({ amount, note }),
    record: (t) => trades.push(t),
    killSwitch: () => env.kill,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { d, env, booked, trades };
}
const orbBars = [...range, bar(TODAY, '09:30', 100.5, 103.5, 100.4, 103.2), bar(TODAY, '09:35', 102.2, 103.0, 101.95, 102.9)];
const at = (hhmm: string) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) - 330) * 60_000).toISOString();

describe('intraday desk (paper)', () => {
  it('opens a long trade on a signal, risking at most 1% of the account and within the 10% / 20% caps', async () => {
    const t = desk({ now: at('09:41'), bars: orbBars, ltp: { ABC: 102.9 } });
    await t.d.tick();
    const [p] = t.d.open();
    expect(p).toMatchObject({ symbol: 'ABC', strategy: 'orb930', side: 'long' });
    expect((p!.entry - p!.stop) * p!.qty).toBeLessThanOrEqual(500_000 * 0.01 + 1);
    expect(p!.entry * p!.qty).toBeLessThanOrEqual(500_000 * 0.1 + 1);
    expect(t.trades[0]).toMatchObject({ side: 'BUY', intraday: true, strategy: 'orb930' });
    expect(t.booked).toHaveLength(0);
  });

  it('closes at the 1:2 target and books the profit after charges; never re-enters the same setup that day', async () => {
    const t = desk({ now: at('09:41'), bars: orbBars, ltp: { ABC: 102.9 } });
    await t.d.tick();
    const p = t.d.open()[0]!;
    t.env.ltp.ABC = p.target + 0.5;
    t.env.now = new Date(at('10:02'));
    await t.d.tick();
    expect(t.d.open()).toHaveLength(0);
    expect(t.booked[0]!.amount).toBeGreaterThan(0);
    expect(t.trades.at(-1)).toMatchObject({ side: 'SELL', reason: 'target 1:2 reached' });
    t.env.now = new Date(at('10:16'));
    t.env.ltp.ABC = 102.9;
    await t.d.tick();
    expect(t.d.open()).toHaveLength(0); // orb930 already traded ABC today
  });

  it('a short trade that hits its stop-loss books a loss', async () => {
    const bars = [...range, bar(TODAY, '09:30', 98.5, 98.6, 96.5, 96.8), bar(TODAY, '09:35', 97.9, 98.05, 97.2, 97.4)];
    const t = desk({ now: at('09:41'), bars, ltp: { ABC: 97.4 } });
    await t.d.tick();
    const p = t.d.open()[0]!;
    expect(p.side).toBe('short');
    expect(t.trades[0]).toMatchObject({ side: 'SHORT' });
    t.env.ltp.ABC = p.stop + 0.1;
    t.env.now = new Date(at('09:50'));
    await t.d.tick();
    expect(t.booked[0]!.amount).toBeLessThan(0);
    expect(t.trades.at(-1)).toMatchObject({ side: 'COVER', reason: 'stop-loss' });
  });

  it('squares off everything at 15:15 and takes no new trades after 15:00', async () => {
    const t = desk({ now: at('09:41'), bars: orbBars, ltp: { ABC: 102.9 } });
    await t.d.tick();
    t.env.now = new Date(at('15:15'));
    await t.d.tick();
    expect(t.d.open()).toHaveLength(0);
    expect(t.trades.at(-1)).toMatchObject({ reason: 'square-off 15:15 IST (intraday)' });
    const late = desk({ now: at('15:02'), bars: orbBars, ltp: { ABC: 102.9 } });
    await late.d.tick();
    expect(late.d.open()).toHaveLength(0);
  });

  it('kill switch: "pause" stops new trades, "sell everything" closes them', async () => {
    const paused = desk({ now: at('09:41'), bars: orbBars, ltp: { ABC: 102.9 }, kill: 'halt' });
    await paused.d.tick();
    expect(paused.d.open()).toHaveLength(0);
    const t = desk({ now: at('09:41'), bars: orbBars, ltp: { ABC: 102.9 } });
    await t.d.tick();
    t.env.kill = 'flatten';
    t.env.now = new Date(at('09:46'));
    await t.d.tick();
    expect(t.d.open()).toHaveLength(0);
  });

  it('respects the daily trade limit and can be switched off', async () => {
    const t = desk({ now: at('09:41'), bars: orbBars, ltp: { A1: 102.9, A2: 102.9, A3: 102.9 }, symbols: ['A1', 'A2', 'A3'], cfg: { maxTradesPerDay: 2 } });
    await t.d.tick();
    expect(t.d.open()).toHaveLength(2);
    const off = desk({ now: at('09:41'), bars: orbBars, ltp: { ABC: 102.9 }, cfg: { enabled: false } });
    await off.d.tick();
    expect(off.d.open()).toHaveLength(0);
  });

  it('never trades on weekends', async () => {
    const t = desk({ now: '2026-11-28T04:11:00Z', bars: orbBars, ltp: { ABC: 102.9 } }); // Saturday
    await t.d.tick();
    expect(t.d.open()).toHaveLength(0);
  });
});
