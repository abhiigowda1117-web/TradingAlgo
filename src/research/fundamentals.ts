import type { CompanyProfile, Metric, StatementPeriod, Unit } from './types';

const YAHOO = 'Yahoo Finance';

export function metric(key: string, label: string, unit: Unit, value: number | null | undefined, kind: Metric['kind'], extra: Partial<Metric> = {}): Metric {
  const ok = typeof value === 'number' && Number.isFinite(value);
  return ok ? { key, label, unit, value, kind, ...extra } : { key, label, unit, value: null, kind: 'unavailable', note: extra.note };
}

/** Compound annual growth between two positive values `years` apart; null if not meaningful. */
export function cagr(first: number | null, last: number | null, years: number): number | null {
  if (first === null || last === null || first <= 0 || last <= 0 || years <= 0) return null;
  return (last / first) ** (1 / years) - 1;
}

export function growth(prev: number | null, cur: number | null): number | null {
  if (prev === null || cur === null || prev <= 0) return null;
  return cur / prev - 1;
}

const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? a / b : null);

export interface FundamentalsSection {
  metrics: Metric[];
  growth: Metric[];
  annual: (StatementPeriod & { operatingMargin: number | null; netMargin: number | null })[];
  quarterly: (StatementPeriod & { operatingMargin: number | null; netMargin: number | null })[];
  latestAnnual: string | null;
  latestQuarter: string | null;
}

/**
 * Builds the fundamentals section. Provider metrics are "reported"; anything this program derives
 * is "calculated" with its formula; forward-looking provider numbers are "estimate". A missing
 * input always yields Not Available, never a guess.
 */
export function analyzeFundamentals(p: CompanyProfile, annual: StatementPeriod[], quarterly: StatementPeriod[]): FundamentalsSection {
  const s = p.stats;
  const la = annual.at(-1) ?? null;
  const asOfA = la?.periodEnd;
  const rep = (key: string, label: string, unit: Unit, v: number | undefined, note?: string) =>
    metric(key, label, unit, v, 'reported', { source: YAHOO, asOf: p.priceTime?.slice(0, 10) ?? undefined, note });
  const calc = (key: string, label: string, unit: Unit, v: number | null, formula: string, asOf = asOfA) =>
    metric(key, label, unit, v, 'calculated', { source: `${YAHOO} statements`, asOf, formula });

  const de = s.debtToEquity !== undefined ? s.debtToEquity / 100 : undefined; // Yahoo reports D/E in percent
  const roce = la ? ratio(la.ebit, la.totalAssets !== null && la.currentLiabilities !== null ? la.totalAssets - la.currentLiabilities : null) : null;
  const roeCalc = la ? ratio(la.netIncome, la.equity) : null;
  const deCalc = la ? ratio(la.totalDebt, la.equity) : null;
  const fcfCalc = la && la.operatingCashFlow !== null && la.capex !== null ? la.operatingCashFlow + la.capex : null; // capex is negative

  const metrics: Metric[] = [
    rep('marketCap', 'Market capitalisation', 'INR', p.marketCap ?? undefined),
    rep('revenueTtm', 'Revenue (trailing 12 months)', 'INR', s.totalRevenue),
    rep('epsTtm', 'EPS (trailing 12 months)', 'INR/share', s.trailingEps),
    metric('epsForward', 'EPS (forward)', 'INR/share', s.forwardEps, 'estimate', { source: `${YAHOO} (analyst consensus)`, note: 'Forecast, not a reported figure' }),
    s.returnOnEquity !== undefined ? rep('roe', 'Return on equity (ROE)', 'pct', s.returnOnEquity) : calc('roe', 'Return on equity (ROE)', 'pct', roeCalc, 'Net income / shareholders’ equity (latest annual)'),
    calc('roce', 'Return on capital employed (ROCE)', 'pct', roce, 'EBIT / (total assets − current liabilities), latest annual'),
    de !== undefined ? rep('debtToEquity', 'Debt to equity', 'ratio', de) : calc('debtToEquity', 'Debt to equity', 'ratio', deCalc, 'Total debt / shareholders’ equity (latest annual)'),
    rep('currentRatio', 'Current ratio', 'ratio', s.currentRatio),
    rep('operatingMargin', 'Operating margin (TTM)', 'pct', s.operatingMargins),
    rep('netMargin', 'Net profit margin (TTM)', 'pct', s.profitMargins),
    rep('operatingCashFlow', 'Operating cash flow (TTM)', 'INR', s.operatingCashflow),
    s.freeCashflow !== undefined
      ? rep('freeCashFlow', 'Free cash flow (TTM)', 'INR', s.freeCashflow, 'Provider definition')
      : calc('freeCashFlow', 'Free cash flow (latest annual)', 'INR', fcfCalc, 'Operating cash flow − capital expenditure'),
    rep('pe', 'P/E (trailing)', 'x', s.trailingPE),
    metric('peForward', 'P/E (forward)', 'x', s.forwardPE, 'estimate', { source: `${YAHOO} (analyst consensus)`, note: 'Based on forecast earnings' }),
    rep('pb', 'Price to book', 'x', s.priceToBook),
    rep('evEbitda', 'EV / EBITDA', 'x', s.enterpriseToEbitda),
    rep('dividendYield', 'Dividend yield', 'pct', s.dividendYield),
    rep('beta', 'Beta', 'ratio', s.beta),
  ];

  const first = annual.length >= 4 ? annual.at(-4)! : annual[0];
  const years = first && la ? (new Date(la.periodEnd).getTime() - new Date(first.periodEnd).getTime()) / (365.25 * 86_400_000) : 0;
  const yrs = Math.round(years);
  const pa = annual.at(-2) ?? null;
  const lq = quarterly.at(-1) ?? null;
  const yq = lq ? quarterly.find((q) => Math.abs(new Date(lq.periodEnd).getTime() - new Date(q.periodEnd).getTime() - 365 * 86_400_000) < 20 * 86_400_000) ?? null : null;

  const growthMetrics: Metric[] = [
    rep('revenueGrowthYahoo', 'Revenue growth (latest quarter, YoY)', 'pct', s.revenueGrowth, 'As reported by the provider'),
    rep('earningsGrowthYahoo', 'Earnings growth (latest quarter, YoY)', 'pct', s.earningsGrowth, 'As reported by the provider'),
    calc('revenueGrowthAnnual', 'Revenue growth (latest year)', 'pct', growth(pa?.revenue ?? null, la?.revenue ?? null), 'Latest annual revenue / previous year − 1'),
    calc('profitGrowthAnnual', 'Net profit growth (latest year)', 'pct', growth(pa?.netIncome ?? null, la?.netIncome ?? null), 'Latest annual net income / previous year − 1'),
    calc('revenueCagr', `Revenue CAGR (${yrs || '?'} years)`, 'pct', yrs >= 2 ? cagr(first?.revenue ?? null, la?.revenue ?? null, years) : null, `(Latest / earliest annual revenue)^(1/${yrs || 'n'}) − 1`),
    calc('profitCagr', `Net profit CAGR (${yrs || '?'} years)`, 'pct', yrs >= 2 ? cagr(first?.netIncome ?? null, la?.netIncome ?? null, years) : null, 'Same, on net income; Not Available if either year was a loss'),
    calc('revenueGrowthQoqYoy', 'Revenue growth (latest quarter vs same quarter last year)', 'pct', growth(yq?.revenue ?? null, lq?.revenue ?? null), 'From quarterly statements', lq?.periodEnd),
    calc('profitGrowthQoqYoy', 'Net profit growth (latest quarter vs same quarter last year)', 'pct', growth(yq?.netIncome ?? null, lq?.netIncome ?? null), 'From quarterly statements', lq?.periodEnd),
  ];

  const withMargins = (p: StatementPeriod) => ({ ...p, operatingMargin: ratio(p.operatingIncome, p.revenue), netMargin: ratio(p.netIncome, p.revenue) });
  return {
    metrics,
    growth: growthMetrics,
    annual: annual.map(withMargins),
    quarterly: quarterly.map(withMargins),
    latestAnnual: la?.periodEnd ?? null,
    latestQuarter: lq?.periodEnd ?? null,
  };
}

export const findMetric = (list: Metric[], key: string) => list.find((m) => m.key === key)?.value ?? null;
