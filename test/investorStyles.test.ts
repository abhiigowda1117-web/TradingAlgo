import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStudyConfig } from '../src/config';
import { readActiveProfile, writeActiveProfile } from '../src/study/activeProfile';
import { withDerivedMetrics } from '../src/study/derived';
import { PROFILE_IDS, PROFILES_INFO, profileById, studyConfigFor, type ProfileId } from '../src/study/profiles';
import { screen } from '../src/study/screener';
import { buildWatchlist } from '../src/study/watchlist';
import { lowest, priorAverage } from '../src/trading/indicators';
import { computeIndicators, entrySignal, exitSignal, STRATEGIES, type StrategyName } from '../src/trading/strategy';
import type { Candle, CompanyFundamentals } from '../src/types';
import { tradingCfg } from './helpers';

const CR = 1e7;
const cfgFor = (name: StrategyName) => ({ ...tradingCfg.strategy, name });

/** Daily candles from closes, with optional volumes (default 100,000). */
function series(closes: number[], volumes: number[] = []): Candle[] {
  const start = Date.parse('2024-01-01T03:45:00Z');
  return closes.map((c, i) => ({ time: new Date(start + i * 86_400_000), open: c, high: c * 1.005, low: c * 0.995, close: c, volume: volumes[i] ?? 100_000 }));
}
const signals = (c: Candle[], name: StrategyName) => {
  const cfg = cfgFor(name);
  const ind = computeIndicators(c, cfg);
  return { cfg, ind, entry: (i = c.length - 1) => entrySignal(c, ind, i, cfg), exit: (t: { stop: number; highestClose: number; entryPrice?: number }, i = c.length - 1) => exitSignal(c, ind, i, t, cfg) };
};
const vols = (n: number, last: number) => [...Array(n - 1).fill(100_000), last];

// A wonderful business at a fair price, and some that are not.
const quality: CompanyFundamentals = {
  symbol: 'QUAL', name: 'Quality Ltd', sector: 'Consumer Defensive', marketCap: 60_000 * CR, pe: 30, pb: 8, roe: 0.25, roa: 0.15, debtToEquity: 0.1,
  revenueGrowth: 0.12, earningsGrowth: 0.18, profitMargin: 0.15, operatingMargin: 0.22, currentRatio: 1.6, dividendYield: 0.012, freeCashflow: 2_000 * CR,
};
const cheapStalwart: CompanyFundamentals = {
  symbol: 'CHEAP', name: 'Cheap Ltd', sector: 'Industrials', marketCap: 8_000 * CR, pe: 9, pb: 1.2, roe: 0.13, roa: 0.08, debtToEquity: 0.2,
  revenueGrowth: 0.05, earningsGrowth: 0.06, profitMargin: 0.09, operatingMargin: 0.12, currentRatio: 2.4, dividendYield: 0.03, freeCashflow: 300 * CR,
};
const bank: CompanyFundamentals = { ...cheapStalwart, symbol: 'BANK', name: 'Bank Ltd', sector: 'Financial Services', pe: 8, roa: 0.02 };
const studyCfg = loadStudyConfig();
const passes = (id: ProfileId, f: CompanyFundamentals) => screen(withDerivedMetrics(f), studyConfigFor(studyCfg, id).screen);

describe('derived metrics', () => {
  it('computes earnings yield, PEG and P/E x P/B only from real, positive numbers', () => {
    const d = withDerivedMetrics(quality);
    expect(d.earningsYield).toBeCloseTo(1 / 30);
    expect(d.peg).toBeCloseTo(30 / 18);
    expect(d.peTimesPb).toBeCloseTo(240);
    const loss = withDerivedMetrics({ ...quality, pe: -5, earningsGrowth: -0.2 });
    expect(loss.earningsYield).toBeUndefined();
    expect(loss.peg).toBeUndefined();
    expect(withDerivedMetrics({ symbol: 'X', name: 'X' })).toEqual({ symbol: 'X', name: 'X' }); // nothing invented
  });
});

describe('stock-picking styles', () => {
  it('Buffett takes the high-return, low-debt business; Graham refuses it as too expensive', () => {
    expect(passes('buffett', quality).passed).toBe(true);
    expect(passes('graham', quality).passed).toBe(false);
    expect(passes('buffett', { ...quality, debtToEquity: 0.9 }).passed).toBe(false);
    expect(passes('buffett', { ...quality, freeCashflow: -1 }).passed).toBe(false);
  });

  it('Graham takes the cheap, liquid, dividend-paying stalwart and nothing with P/E x P/B above 22.5', () => {
    expect(passes('graham', cheapStalwart).passed).toBe(true);
    expect(passes('graham', { ...cheapStalwart, pb: 2.6 }).passed).toBe(false); // 9 x 2.6 = 23.4
    expect(passes('graham', { ...cheapStalwart, currentRatio: 1.5 }).passed).toBe(false);
    expect(passes('graham', { ...cheapStalwart, dividendYield: 0 }).passed).toBe(false);
  });

  it('Magic Formula excludes banks and utilities, as Greenblatt does', () => {
    expect(passes('greenblatt', cheapStalwart).passed).toBe(true);
    const r = passes('greenblatt', bank);
    expect(r.passed).toBe(false);
    expect(r.excludedSector).toBe('Financial Services');
  });

  it('Lynch wants growth at a reasonable price (PEG at most 1)', () => {
    expect(passes('lynch', { ...quality, pe: 20, earningsGrowth: 0.25 }).passed).toBe(true); // PEG 0.8
    expect(passes('lynch', quality).passed).toBe(false); // PEG 1.67
  });

  it('a strict style never lets a company through on missing data', () => {
    for (const id of PROFILE_IDS.filter((x) => x !== 'balanced')) {
      const r = passes(id, { symbol: 'NODATA', name: 'No Data Ltd' });
      expect(r.passed, id).toBe(false);
    }
  });

  it('every style is described, names a real Strategy Lab strategy, and uses known metrics', () => {
    const names = STRATEGIES.map((s) => s.name);
    for (const p of PROFILES_INFO) {
      expect(p.summary.length, p.id).toBeGreaterThan(20);
      expect(p.picks.length, p.id).toBeGreaterThan(0);
      expect(p.source.length, p.id).toBeGreaterThan(10);
      expect(p.limits.length, p.id).toBeGreaterThan(10);
      expect(names, p.id).toContain(p.pairsWith);
    }
    const metrics = Object.keys(withDerivedMetrics({ ...quality }));
    for (const id of PROFILE_IDS) {
      const cfg = studyConfigFor(studyCfg, id);
      for (const r of cfg.screen.rules) expect(metrics, `${id} ${r.metric}`).toContain(r.metric);
      for (const m of Object.keys(cfg.scoring)) expect(metrics, `${id} ${m}`).toContain(m);
    }
  });

  it('balanced keeps config/study.json exactly; the watchlist records the style that built it', () => {
    expect(studyConfigFor(studyCfg, 'balanced')).toEqual(studyCfg);
    const p = profileById('buffett');
    const wl = buildWatchlist([], studyCfg.watchlist, new Date('2026-11-11T00:00:00Z'), { id: p.id, name: p.name, investor: p.investor });
    expect(wl.profile).toEqual({ id: 'buffett', name: p.name, investor: 'Warren Buffett' });
  });

  it('remembers the style chosen on the website and ignores a bad file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'profile-'));
    const file = join(dir, 'active-profile.json');
    expect(readActiveProfile(file)).toEqual({ id: 'balanced', source: 'default' });
    writeActiveProfile(file, 'qglp', 'abhi', new Date('2026-11-11T05:00:00Z'));
    expect(readActiveProfile(file)).toEqual({ id: 'qglp', changedBy: 'abhi', changedAt: '2026-11-11T05:00:00.000Z', source: 'website' });
    writeFileSync(file, '{"id":"madeup"}');
    expect(readActiveProfile(file).id).toBe('balanced');
    expect(() => writeActiveProfile(file, 'madeup' as ProfileId, 'abhi')).toThrow();
  });
});

describe('new indicators', () => {
  it('priorAverage excludes the bar itself; lowest includes it', () => {
    expect(priorAverage([1, 3, 5, 100], 2)).toEqual([NaN, NaN, 2, 4]);
    expect(lowest([5, 3, 4, 6], 2)).toEqual([NaN, 3, 3, 4]);
  });
});

describe('investor and trader strategies', () => {
  // Steady 0.3%/day uptrend, a 25-day pause just below the high, then a breakout bar.
  const rise = Array.from({ length: 280 }, (_, i) => 100 * 1.003 ** i);
  const base = rise.at(-1)! * 0.98;
  const minerviniCloses = [...rise, ...Array(25).fill(base), base * 1.05];

  it('Minervini: buys a Trend Template stock breaking out on volume, not on a quiet day or in a downtrend', () => {
    const n = minerviniCloses.length;
    const ok = signals(series(minerviniCloses, vols(n, 150_000)), 'minervini').entry();
    expect(ok).toMatchObject({ enter: true, reason: expect.stringMatching(/Trend Template uptrend/) });
    if (!ok.enter) throw new Error('expected a buy');
    expect(ok.stop).toBeGreaterThanOrEqual(base * 1.05 * 0.92 - 1e-9); // never more than 8% below the buy
    expect(signals(series(minerviniCloses, vols(n, 120_000)), 'minervini').entry()).toMatchObject({ enter: false, reason: expect.stringMatching(/volume/) });
    const falling = [...minerviniCloses].reverse();
    expect(signals(series(falling, vols(n, 300_000)), 'minervini').entry()).toMatchObject({ enter: false, reason: 'not in a Trend Template uptrend' });
  });

  it('Minervini: sells when the close falls below the 50-day average', () => {
    const c = series([...minerviniCloses, base * 0.9]);
    expect(signals(c, 'minervini').exit({ stop: base * 0.8, highestClose: base * 1.05 })).toMatchObject({ exit: true, reason: 'close below the 50-day average' });
  });

  const flat = Array(300).fill(100);
  it('CAN SLIM: buys a breakout from a 50-day base near the highs on heavy volume; 8% stop', () => {
    const closes = [...flat, 104];
    const e = signals(series(closes, vols(closes.length, 150_000)), 'canslim').entry();
    expect(e).toMatchObject({ enter: true, stop: 104 * 0.92 });
    expect(signals(series(closes, vols(closes.length, 120_000)), 'canslim').entry().enter).toBe(false);
    // Breaking a base 30% under the 52-week high is not a CAN SLIM buy.
    const fallen = [...Array(100).fill(150), ...Array(200).fill(100), 104];
    expect(signals(series(fallen, vols(fallen.length, 200_000)), 'canslim').entry()).toMatchObject({ enter: false, reason: expect.stringMatching(/52-week high/) });
  });

  it('CAN SLIM: takes profit at +25% and sells below the 50-day average', () => {
    const up = signals(series([...flat, 126]), 'canslim');
    expect(up.exit({ stop: 92, highestClose: 120, entryPrice: 100 })).toMatchObject({ exit: true, reason: expect.stringMatching(/\+25%/) });
    expect(up.exit({ stop: 92, highestClose: 120, entryPrice: 110 }).exit).toBe(false); // only +14.5%
    expect(signals(series([...flat, 97]), 'canslim').exit({ stop: 92, highestClose: 104, entryPrice: 100 })).toMatchObject({ exit: true, reason: 'close below the 50-day average' });
  });

  const stage1to2 = [...Array.from({ length: 200 }, (_, i) => 100 * 1.002 ** i), ...Array(55).fill(150)];
  it('Weinstein: buys the Stage 2 breakout above a rising 30-week line on double volume', () => {
    const closes = [...stage1to2, 156];
    expect(signals(series(closes, vols(closes.length, 250_000)), 'weinstein').entry()).toMatchObject({ enter: true, reason: expect.stringMatching(/Stage 2 breakout/) });
    expect(signals(series(closes, vols(closes.length, 150_000)), 'weinstein').entry()).toMatchObject({ enter: false, reason: expect.stringMatching(/twice/) });
  });

  it('Weinstein: holds above the 30-week line with the stop trailing up to 5% below it, sells below it', () => {
    const s = signals(series([...stage1to2, 156]), 'weinstein');
    const m = s.ind.sma150!.at(-1)!;
    expect(s.exit({ stop: 100, highestClose: 156 })).toMatchObject({ exit: false, stop: m * 0.95 });
    expect(s.exit({ stop: m, highestClose: 156 })).toMatchObject({ exit: false, stop: m }); // never moves down
    expect(signals(series([...stage1to2, 120]), 'weinstein').exit({ stop: 100, highestClose: 156 })).toMatchObject({ exit: true });
  });

  const longUp = Array.from({ length: 260 }, (_, i) => 100 * 1.001 ** i);
  it('Buy right, sit tight: buys a long-term uptrend but not a stretched spike', () => {
    expect(signals(series(longUp), 'buyHold').entry()).toMatchObject({ enter: true });
    expect(signals(series([...longUp, longUp.at(-1)! * 1.3]), 'buyHold').entry()).toMatchObject({ enter: false, reason: expect.stringMatching(/stretched/) });
    expect(signals(series([...longUp].reverse()), 'buyHold').entry().enter).toBe(false);
  });

  it('Buy right, sit tight: sits through a normal dip and sells only 10% below the 200-day average', () => {
    const s = signals(series(longUp), 'buyHold');
    const m = s.ind.sma200!.at(-1)!;
    const dip = signals(series([...longUp, m * 0.95]), 'buyHold');
    expect(dip.exit({ stop: 50, highestClose: longUp.at(-1)! }).exit).toBe(false);
    expect(dip.exit({ stop: 50, highestClose: longUp.at(-1)! })).toMatchObject({ stop: expect.closeTo(dip.ind.sma200!.at(-1)! * 0.9, 6) });
    expect(signals(series([...longUp, m * 0.85]), 'buyHold').exit({ stop: 50, highestClose: longUp.at(-1)! })).toMatchObject({ exit: true, reason: expect.stringMatching(/long-term trend broken/) });
  });
});
