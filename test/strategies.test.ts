import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readActiveStrategy, writeActiveStrategy } from '../src/trading/activeStrategy';
import { highest, priorHighest, priorLowest, sma, supertrend } from '../src/trading/indicators';
import { runPortfolioBacktest } from '../src/trading/portfolioBacktest';
import { validateTradingConfig } from '../src/trading/risk';
import { STRATEGIES, STRATEGY_IDS } from '../src/trading/strategy';
import type { Candle } from '../src/types';
import { setLogFile } from '../src/util/log';
import { at, EVAL, fixture } from './engineFixture';
import { syntheticCandles, tradingCfg } from './helpers';

/** Daily candles from closes (high/low 1% around the close unless given). */
function series(closes: number[], opts: { range?: number } = {}): Candle[] {
  const r = opts.range ?? 0.01;
  const start = Date.parse('2024-01-01T03:45:00Z');
  return closes.map((c, i) => ({ time: new Date(start + i * 86_400_000), open: c, high: c * (1 + r), low: c * (1 - r), close: c, volume: 100_000 }));
}
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


describe('only the strategy from the owner\'s document', () => {
  it('the daily strategy list is exactly EMA 5/48 + RSI + MACD, described, and it trades in the portfolio backtest', () => {
    expect(STRATEGY_IDS).toEqual(['ema548']);
    expect(STRATEGIES.map((s) => s.name)).toEqual(['EMA 5/48 + RSI + MACD']);
    for (const s of STRATEGIES) expect(s.name && s.buy && s.sell && s.style && s.summary && s.suits).toBeTruthy();
    const candles = Object.fromEntries(['A', 'B', 'C', 'D'].map((s, k) => [s, syntheticCandles(900, { seed: 3 + k * 4 })]));
    const days = candles.A!.map((x) => x.time.toISOString().slice(0, 10));
    const r = runPortfolioBacktest(candles, { strategy: tradingCfg.strategy, risk: tradingCfg.risk, costs: tradingCfg.backtest.costs, slippagePct: 0.0005, initialCapital: 500_000, start: days[300]!, end: days.at(-1)! });
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.curve.every((p) => Number.isFinite(p.equity) && p.equity > 0)).toBe(true);
    expect(r.trades.some((t) => /target 1:2/.test(t.exitReason))).toBe(true);
  });

  it('a retired strategy name in the settings is a config error', () => {
    expect(validateTradingConfig({ ...tradingCfg, strategy: { ...tradingCfg.strategy, name: 'emaTrend' as never } })).toContainEqual(expect.stringMatching(/strategy.name must be one of ema548/));
  });
});

describe('active strategy for the engine', () => {
  it('reads the website choice; an old or bad file falls back to the current strategy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-'));
    const path = join(dir, 'active.json');
    expect(readActiveStrategy(path)).toEqual({ name: 'ema548', source: 'config' });
    writeActiveStrategy(path, 'ema548', 'abhi', new Date('2026-11-06T05:00:00Z'));
    expect(readActiveStrategy(path)).toEqual({ name: 'ema548', changedBy: 'abhi', changedAt: '2026-11-06T05:00:00.000Z', source: 'website' });
    writeFileSync(path, '{"name":"buyHold"}'); // chosen before the old strategies were removed
    expect(readActiveStrategy(path)).toMatchObject({ name: 'ema548', source: 'config' });
    expect(() => writeActiveStrategy(path, 'magic' as never, 'x')).toThrow();
  });

  it('the engine buys with EMA 5/48 + RSI + MACD and records it on the trade', async () => {
    const f = fixture();
    f.paths.activeStrategy = join(f.dir, 'active.json');
    const e = f.engine();
    await e.tick();
    expect(e.state.positions.SYN!.strategy).toBe('ema548');
    expect(f.trades()[0]).toMatchObject({ side: 'BUY', strategy: 'ema548' });
  });

  it('holdings bought by a removed strategy are managed by the new strategy\'s sell rules', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    e.state.positions.SYN!.strategy = 'buyHold' as never; // as saved by an older version
    // Next day: the stock falls hard, EMA 5/48 + RSI + MACD says sell.
    const c = f.market.candles.SYN!;
    const last = c.at(-1)!;
    const crash = { ...last, time: new Date(at('2026-10-30T03:45:00Z')), open: last.close * 0.9, high: last.close * 0.9, low: last.close * 0.7, close: last.close * 0.72 };
    f.market.candles.SYN = [...c, crash];
    f.clock = at('2026-10-30T09:45:00Z');
    await e.tick();
    const p = e.state.positions.SYN;
    expect(p === undefined || p.exitReason !== undefined).toBe(true);
  });
});

describe('daily check summary in the engine log', () => {
  it('a day without buy signals is written to the log, with the reason for each stock', async () => {
    const f = fixture();
    const logFile = join(f.dir, 'engine.log');
    setLogFile(logFile);
    // A steadily falling stock, dated so its last bar is today: no buy signal.
    const end = at(EVAL).getTime();
    f.market.candles.SYN = series(Array.from({ length: 300 }, (_, i) => 500 - i)).map((x, i) => ({ ...x, time: new Date(end - (299 - i) * 86_400_000 - 6 * 3_600_000) }));
    await f.engine().tick();
    expect(readFileSync(logFile, 'utf8')).toMatch(/Daily check done \(EMA 5\/48 \+ RSI \+ MACD\): 1 of 1 watchlist stocks checked, 0 bought\. No buy signal today: SYN \(EMA 5 not above EMA 48\)/);
  });
});

describe('several companies in one daily check', () => {
  it('buys every watchlist company that gives a buy signal at the same check, each with its own stop-loss', async () => {
    const f = fixture({ symbols: ['AAA', 'BBB', 'CCC'] });
    const e = f.engine();
    await e.tick();
    expect(Object.keys(e.state.positions).sort()).toEqual(['AAA', 'BBB', 'CCC']);
    for (const s of ['AAA', 'BBB', 'CCC']) expect(await f.workingStops(s)).toHaveLength(1);
  });

  it('never more than the open-positions limit (5)', async () => {
    const symbols = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
    const f = fixture({ symbols, cfg: { ...tradingCfg, risk: { ...tradingCfg.risk, maxPositionPct: 0.1, maxTotalExposurePct: 0.9 } } });
    const e = f.engine();
    await e.tick();
    expect(Object.keys(e.state.positions).length).toBe(tradingCfg.risk.maxOpenPositions);
  });
});
