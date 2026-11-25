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
import { STRATEGIES } from '../src/trading/strategy';
import type { Candle, CompanyFundamentals } from '../src/types';
import { tradingCfg } from './helpers';

const CR = 1e7;

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
