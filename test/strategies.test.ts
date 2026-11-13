import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readActiveStrategy, writeActiveStrategy } from '../src/trading/activeStrategy';
import { highest, priorHighest, priorLowest, sma, supertrend } from '../src/trading/indicators';
import { runPortfolioBacktest } from '../src/trading/portfolioBacktest';
import { validateTradingConfig } from '../src/trading/risk';
import { computeIndicators, entrySignal, exitSignal, maxWarmupBars, STRATEGIES, STRATEGY_IDS, warmupBars, type StrategyName } from '../src/trading/strategy';
import type { Candle } from '../src/types';
import { at, entryCandles, fixture } from './engineFixture';
import { syntheticCandles, tradingCfg } from './helpers';

const cfgFor = (name: StrategyName) => ({ ...tradingCfg.strategy, name });

/** Daily candles from closes (high/low 1% around the close unless given). */
function series(closes: number[], opts: { range?: number } = {}): Candle[] {
  const r = opts.range ?? 0.01;
  const start = Date.parse('2024-01-01T03:45:00Z');
  return closes.map((c, i) => ({ time: new Date(start + i * 86_400_000), open: c, high: c * (1 + r), low: c * (1 - r), close: c, volume: 100_000 }));
}
const firstEntry = (c: Candle[], name: StrategyName) => {
  const cfg = cfgFor(name);
  const ind = computeIndicators(c, cfg);
  return c.findIndex((_, i) => entrySignal(c, ind, i, cfg).enter);
};

describe('new indicators', () => {
  it('SMA, prior highs/lows (bar itself excluded) and rolling highs', () => {
    expect(sma([1, 2, 3, 4], 2).slice(1)).toEqual([1.5, 2.5, 3.5]);
    expect(Number.isNaN(sma([1, 2, 3], 2)[0]!)).toBe(true);
    expect(priorHighest([1, 5, 2, 3], 2)).toEqual([NaN, NaN, 5, 5]);
    expect(priorLowest([4, 1, 2, 3], 2)).toEqual([NaN, NaN, 1, 1]);
    expect(highest([1, 5, 2, 3], 2)).toEqual([NaN, 5, 5, 3]);
  });

  it('Supertrend is up (line below price) in an uptrend and flips down after a fall', () => {
    const c = series([...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 139 - i * 3)]);
    const st = supertrend(c, 10, 3);
    expect(st.dir[39]).toBe(1);
    expect(st.value[39]!).toBeLessThan(c[39]!.close);
    expect(st.dir.at(-1)).toBe(-1);
    expect(st.value.at(-1)!).toBeGreaterThan(c.at(-1)!.close);
  });
});

describe('strategy rules', () => {
  it('Donchian: buys a fresh break of the 55-day high once, sells below the 20-day low', () => {
    const closes = [...Array(60).fill(100), 104, 105, 106, ...Array(5).fill(106), 96];
    const c = series(closes, { range: 0.005 });
    const cfg = cfgFor('donchian');
    const ind = computeIndicators(c, cfg);
    expect(entrySignal(c, ind, 59, cfg).enter).toBe(false);
    const e = entrySignal(c, ind, 60, cfg);
    expect(e).toMatchObject({ enter: true, reason: expect.stringMatching(/broke the 55-day high/) });
    expect(entrySignal(c, ind, 61, cfg).enter).toBe(false); // not a fresh breakout any more
    const x = exitSignal(c, ind, c.length - 1, { stop: 90, highestClose: 106 }, cfg);
    expect(x).toMatchObject({ exit: true, reason: expect.stringMatching(/below the 20-day low/) });
    // While holding, the stop trails up to the 20-day low, never down.
    const hold = exitSignal(c, ind, 66, { stop: 50, highestClose: 106 }, cfg);
    expect(hold.exit).toBe(false);
    if (!hold.exit) expect(hold.stop).toBeGreaterThan(50);
  });

  it('RSI-2: buys a sharp dip above the 200-day average, sells on the bounce above the 5-day average', () => {
    const up = Array.from({ length: 210 }, (_, i) => 100 + i * 0.5);
    const closes = [...up, up.at(-1)! - 4, up.at(-1)! - 8, up.at(-1)! - 1];
    const c = series(closes, { range: 0.004 });
    const cfg = cfgFor('rsi2');
    const ind = computeIndicators(c, cfg);
    expect(entrySignal(c, ind, 209, cfg).enter).toBe(false); // RSI(2) high in a steady rise
    expect(entrySignal(c, ind, 211, cfg)).toMatchObject({ enter: true, reason: expect.stringMatching(/RSI\(2\) [\d.]+ dip/) });
    expect(exitSignal(c, ind, 212, { stop: 200, highestClose: closes[211]! }, cfg)).toMatchObject({ exit: true, reason: 'bounced above the 5-day average' });
  });

  it('52-week high momentum: buys a fresh 20-day high near the 52-week high in a rising trend, sells below the 50-day average', () => {
    const rise = Array.from({ length: 260 }, (_, i) => 100 + i * 0.4);
    const top = rise.at(-1)!;
    const base = Array.from({ length: 22 }, (_, i) => top - 2 - (i % 3) * 0.2);
    const closes = [...rise, ...base, top + 1];
    const c = series(closes, { range: 0.003 });
    const cfg = cfgFor('momentum52');
    const ind = computeIndicators(c, cfg);
    const i = closes.length - 1;
    expect(entrySignal(c, ind, i, cfg)).toMatchObject({ enter: true, reason: expect.stringMatching(/new 20-day high/) });
    expect(entrySignal(c, ind, i - 1, cfg).enter).toBe(false);
    const fall = series([...closes, ...Array.from({ length: 15 }, (_, k) => top - 6 - k * 2)], { range: 0.003 });
    const fi = computeIndicators(fall, cfg);
    expect(exitSignal(fall, fi, fall.length - 1, { stop: 1, highestClose: top + 1 }, cfg)).toMatchObject({ exit: true, reason: 'close below the 50-day average' });
  });

  it('Supertrend: buys the flip up, sells the flip down, stop trails the line', () => {
    const closes = [...Array.from({ length: 30 }, (_, i) => 200 - i * 2), ...Array.from({ length: 40 }, (_, i) => 142 + i * 3), ...Array.from({ length: 25 }, (_, i) => 259 - i * 5)];
    const c = series(closes);
    const cfg = cfgFor('supertrend');
    const ind = computeIndicators(c, cfg);
    const i = firstEntry(c, 'supertrend');
    expect(i).toBeGreaterThan(30);
    const e = entrySignal(c, ind, i, cfg);
    expect(e.enter && e.stop < c[i]!.close).toBe(true);
    const flipDown = c.findIndex((_, k) => k > i && ind.stDir![k] === -1);
    expect(flipDown).toBeGreaterThan(i);
    expect(exitSignal(c, ind, flipDown, { stop: 1, highestClose: 300 }, cfg)).toMatchObject({ exit: true, reason: 'Supertrend flipped down' });
  });

  it('every strategy is described, has a warmup, and runs through the portfolio backtest', () => {
    expect(STRATEGIES.map((s) => s.id)).toEqual([...STRATEGY_IDS]);
    for (const s of STRATEGIES) expect(s.name && s.buy && s.sell && s.style && s.summary && s.suits).toBeTruthy();
    expect(maxWarmupBars(tradingCfg.strategy)).toBe(Math.max(...STRATEGY_IDS.map((id) => warmupBars(cfgFor(id)))));
    const candles = Object.fromEntries(['A', 'B', 'C', 'D'].map((s, k) => [s, syntheticCandles(900, { seed: 3 + k * 4 })]));
    const days = candles.A!.map((x) => x.time.toISOString().slice(0, 10));
    let traded = 0;
    for (const name of STRATEGY_IDS) {
      const r = runPortfolioBacktest(candles, { strategy: cfgFor(name), risk: tradingCfg.risk, costs: tradingCfg.backtest.costs, slippagePct: 0.0005, initialCapital: 500_000, start: days[300]!, end: days.at(-1)! });
      expect(r.curve.length).toBeGreaterThan(500);
      expect(r.curve.every((p) => Number.isFinite(p.equity) && p.equity > 0)).toBe(true);
      if (r.trades.length > 0) traded++;
    }
    expect(traded).toBeGreaterThanOrEqual(4);
  });

  it('the default is the original EMA Trend strategy, and an unknown name is a config error', () => {
    const c = entryCandles();
    const plain = computeIndicators(c, tradingCfg.strategy);
    const named = computeIndicators(c, cfgFor('emaTrend'));
    expect(entrySignal(c, plain, c.length - 1, tradingCfg.strategy)).toEqual(entrySignal(c, named, c.length - 1, cfgFor('emaTrend')));
    expect(validateTradingConfig({ ...tradingCfg, strategy: { ...tradingCfg.strategy, name: 'magic' as never } })).toContainEqual(expect.stringMatching(/strategy.name must be one of/));
  });
});

describe('active strategy for the engine', () => {
  it('reads the website choice, falls back to the config, and ignores a bad file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-'));
    const path = join(dir, 'active.json');
    expect(readActiveStrategy(path)).toEqual({ name: 'emaTrend', source: 'config' });
    expect(readActiveStrategy(path, 'rsi2').name).toBe('rsi2');
    writeActiveStrategy(path, 'donchian', 'abhi', new Date('2026-11-06T05:00:00Z'));
    expect(readActiveStrategy(path)).toEqual({ name: 'donchian', changedBy: 'abhi', changedAt: '2026-11-06T05:00:00.000Z', source: 'website' });
    writeFileSync(path, '{"name":"magic"}');
    expect(readActiveStrategy(path, 'supertrend')).toMatchObject({ name: 'supertrend', source: 'config' });
    expect(() => writeActiveStrategy(path, 'magic' as never, 'x')).toThrow();
  });

  it('the engine buys with the active strategy and each position exits by the strategy that opened it', async () => {
    const f = fixture();
    f.paths.activeStrategy = join(f.dir, 'active.json');
    const e = f.engine();
    await e.tick(); // default emaTrend buys SYN on its entry signal
    expect(e.state.positions.SYN!.strategy).toBe('emaTrend');
    expect(f.trades()[0]).toMatchObject({ side: 'BUY', strategy: 'emaTrend' });

    // Choosing another strategy does not change how the existing position is managed.
    writeActiveStrategy(f.paths.activeStrategy, 'supertrend', 'abhi');
    const g = fixture();
    g.paths.activeStrategy = join(g.dir, 'active.json');
    writeActiveStrategy(g.paths.activeStrategy, 'supertrend', 'abhi');
    const c = entryCandles();
    const wouldBuy = entrySignal(c, computeIndicators(c, cfgFor('supertrend')), c.length - 1, cfgFor('supertrend')).enter;
    const e2 = g.engine();
    await e2.tick();
    if (wouldBuy) expect(e2.state.positions.SYN!.strategy).toBe('supertrend');
    else expect(e2.state.positions.SYN).toBeUndefined();
    expect(e.state.positions.SYN!.strategy).toBe('emaTrend');
  });

  it('after switching strategy, an open position still exits only by its own rules', async () => {
    const f = fixture();
    f.paths.activeStrategy = join(f.dir, 'active.json');
    const e = f.engine();
    await e.tick();
    expect(e.state.positions.SYN!.strategy).toBe('emaTrend');
    writeActiveStrategy(f.paths.activeStrategy, 'rsi2', 'abhi');
    // Next day's bar: RSI-2 would sell (close above its 5-day average), EMA Trend would hold.
    const next = entryCandles('2026-10-30');
    const i = next.length - 1;
    const t = { stop: e.state.positions.SYN!.stop, highestClose: e.state.positions.SYN!.highestClose };
    expect(exitSignal(next, computeIndicators(next, cfgFor('rsi2')), i, t, cfgFor('rsi2')).exit).toBe(true);
    expect(exitSignal(next, computeIndicators(next, cfgFor('emaTrend')), i, t, cfgFor('emaTrend')).exit).toBe(false);
    f.market.candles.SYN = next;
    f.clock = at('2026-10-30T09:45:00Z');
    await e.tick();
    expect(e.state.positions.SYN).toBeDefined();
    expect(e.state.positions.SYN!.exitReason).toBeUndefined();
  });
});

describe('daily check summary in the engine log', () => {
  it('a day without buy signals is written to the log, with the reason for each stock', async () => {
    const { setLogFile } = await import('../src/util/log');
    const { readFileSync } = await import('node:fs');
    const f = fixture();
    const logFile = join(f.dir, 'engine.log');
    setLogFile(logFile);
    f.paths.activeStrategy = join(f.dir, 'active.json');
    writeActiveStrategy(f.paths.activeStrategy, 'donchian', 'abhi'); // the fixture's candles do not break a 55-day high
    const c = entryCandles();
    expect(entrySignal(c, computeIndicators(c, cfgFor('donchian')), c.length - 1, cfgFor('donchian')).enter).toBe(false);
    await f.engine().tick();
    const text = readFileSync(logFile, 'utf8');
    expect(text).toMatch(/Daily check done \(Donchian Breakout\): 1 of 1 watchlist stocks checked, 0 bought\. No buy signal today: SYN \(/);
  });
});
