import { describe, expect, it } from 'vitest';
import { buffettAnalysis, discountedValue, isFinancialSector, type BuffettAnalysis } from '../src/research/buffett';
import { analyzeFundamentals } from '../src/research/fundamentals';
import { mapProfile } from '../src/research/sources';
import type { CompanyProfile, StatementPeriod } from '../src/research/types';

const CR = 1e7;
const year = (y: number, p: Partial<StatementPeriod>): StatementPeriod => ({
  periodEnd: `${y}-03-31`, revenue: null, operatingIncome: null, netIncome: null, eps: null, ebit: null, operatingCashFlow: null, capex: null,
  freeCashFlow: null, totalDebt: null, equity: null, totalAssets: null, currentLiabilities: null, ...p,
});

function profile(stats: Record<string, number | undefined>, o: Partial<CompanyProfile> = {}): CompanyProfile {
  return { ...mapProfile('X', { price: { longName: 'X Ltd', regularMarketPrice: 1000 } }), marketCap: 40_000 * CR, price: 1000, stats, sector: 'Consumer Defensive', industry: 'Household products', ...o };
}

/** A See's Candies-like business: high, steady returns, no debt, little capital, growing. */
const wonderful = [2022, 2023, 2024, 2025].map((y, i) => {
  const rev = 10_000 * CR * 1.12 ** i;
  return year(y, { revenue: rev, operatingIncome: rev * 0.22, netIncome: rev * 0.16, operatingCashFlow: rev * 0.18, capex: -rev * 0.04, totalDebt: 0, equity: (6_000 + 800 * i) * CR });
});
/** Erratic, indebted and capital-hungry. */
const poor = [2022, 2023, 2024, 2025].map((y, i) =>
  year(y, { revenue: 10_000 * CR, operatingIncome: [1_500, 300, 900, 200][i]! * CR, netIncome: [600, -200, 300, 50][i]! * CR, operatingCashFlow: 800 * CR, capex: -1_200 * CR, totalDebt: 9_000 * CR, equity: 5_000 * CR }),
);

function analyse(annual: StatementPeriod[], stats: Record<string, number | undefined> = {}, o: Partial<CompanyProfile> = {}, peerOpm: number | null = null): BuffettAnalysis {
  const p = profile(stats, o);
  return buffettAnalysis({
    fundamentals: analyzeFundamentals(p, annual, []),
    sector: p.sector, industry: p.industry, officers: [{ name: 'A. Person', title: 'MD' }], price: p.price,
    peerMedians: peerOpm === null ? null : { marketCap: null, revenueGrowth: null, operatingMargin: peerOpm, netMargin: null, roe: null, debtToEquity: null, pe: null, pb: null },
  });
}
const verdicts = (b: BuffettAnalysis) => Object.fromEntries(b.checks.map((c) => [c.key, c.verdict]));

describe('discounted value (owner earnings)', () => {
  it('matches a hand calculation and refuses impossible inputs', () => {
    // No growth, 10% discount, no terminal growth: a perpetuity worth 10x.
    expect(discountedValue(100, 0, 0.1, 0, 10)!).toBeCloseTo(1000, 6);
    expect(discountedValue(100, 0.1, 0.12, 0.05, 10)!).toBeGreaterThan(discountedValue(100, 0.05, 0.12, 0.05, 10)!);
    expect(discountedValue(-5, 0.1, 0.12, 0.05)).toBeNull();
    expect(discountedValue(100, 0.1, 0.05, 0.05)).toBeNull(); // discount rate must exceed long-term growth
  });
});

describe("Buffett's checklist", () => {
  it('a wonderful business passes the business and financial tests, with the figures to show it', () => {
    const b = analyse(wonderful, { debtToEquity: 0 }, {}, 0.15);
    const v = verdicts(b);
    expect(v).toMatchObject({ consistency: 'meets', pricingPower: 'meets', roe: 'meets', debt: 'meets', margins: 'meets', ownerEarnings: 'meets', capitalLight: 'meets', retained: 'meets', understand: 'judgement', moat: 'judgement', management: 'judgement' });
    expect(b.checks.find((c) => c.key === 'moat')!.reality).toMatch(/consistent with a moat/);
    expect(b.checks.find((c) => c.key === 'roe')!.reality).toMatch(/26\.7%/); // 2022: 1,600 / 6,000
    expect(b.verdict).toBe('strong');
    expect(b.strengths).toContain('Does it carry little or no debt');
  });

  it('cash conversion: 18% cash on 16% profit minus 4% capex is 87.5 paise per rupee', () => {
    const b = analyse(wonderful);
    expect(b.checks.find((c) => c.key === 'ownerEarnings')!.reality).toMatch(/88 paise/);
  });

  it('an erratic, indebted, capital-hungry business fails, and the reasons are named', () => {
    const b = analyse(poor, {}, {}, 0.12);
    const v = verdicts(b);
    expect(v).toMatchObject({ consistency: 'fails', pricingPower: 'fails', roe: 'fails', debt: 'fails', margins: 'fails', ownerEarnings: 'fails', capitalLight: 'fails', price: 'fails' });
    expect(b.checks.find((c) => c.key === 'consistency')!.reality).toMatch(/loss in 2023/);
    expect(b.verdict).toBe('weak');
    expect(b.checks.find((c) => c.key === 'price')!.reality).toMatch(/nothing to value/);
  });

  it('price: the same business passes at a low market value and fails at a high one', () => {
    const cheap = analyse(wonderful, {}, { marketCap: 10_000 * CR });
    const dear = analyse(wonderful, {}, { marketCap: 500_000 * CR });
    expect(verdicts(cheap).price).toBe('meets');
    expect(verdicts(dear).price).toBe('fails');
    expect(cheap.valuation.estimatedValue).toBeCloseTo(dear.valuation.estimatedValue!, 0);
    expect(cheap.valuation.discountToValue!).toBeGreaterThan(0.25);
    // Growth assumption: the lower of past revenue and profit growth (both 12%), within the 15% cap.
    expect(cheap.valuation.defaults.growth).toBeCloseTo(0.12, 3);
  });

  it('never invents numbers: with no statements everything measurable is Not Available', () => {
    const b = analyse([]);
    for (const c of b.checks) expect(['na', 'judgement'], c.key).toContain(c.verdict);
    expect(b.verdict).toBe('insufficient');
    expect(b.valuation.estimatedValue).toBeNull();
  });

  it('banks: debt, cash-flow and capital tests do not apply; value comes from profit', () => {
    expect(isFinancialSector('Financial Services', 'Banks - Regional')).toBe(true);
    expect(isFinancialSector('Technology', 'Software')).toBe(false);
    const bank = analyse(wonderful.map((p) => ({ ...p, totalDebt: 50_000 * CR })), {}, { sector: 'Financial Services', industry: 'Banks - Regional' });
    const v = verdicts(bank);
    expect(v).toMatchObject({ debt: 'notApplicable', ownerEarnings: 'notApplicable', capitalLight: 'notApplicable', margins: 'notApplicable', roe: 'meets' });
    expect(bank.valuation.basis).toMatch(/net profit/);
  });
});
