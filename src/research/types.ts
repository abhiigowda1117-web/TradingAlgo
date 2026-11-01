import type { Candle, NewsArticle } from '../types';

export type { Candle, NewsArticle };

/**
 * Company research data model. Every number carries its provenance so the report can separate
 * facts from calculations, estimates and interpretation. Missing data is `null`, shown as
 * "Not Available"; nothing is ever filled in.
 */

/** reported: taken from a data source as-is. calculated: derived by this program from reported inputs
 * (formula given). estimate: an analyst/provider forecast, not a fact. unavailable: no data. */
export type Provenance = 'reported' | 'calculated' | 'estimate' | 'unavailable';

export type Unit = 'INR' | 'pct' | 'ratio' | 'x' | 'INR/share' | 'count';

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  unit: Unit;
  kind: Provenance;
  source?: string;
  asOf?: string;
  formula?: string;
  note?: string;
}

export interface SourceRef {
  name: string;
  url?: string;
  retrievedAt: string;
  /** Date of the latest data point this source provided. */
  asOf?: string;
  note?: string;
}

/** One reporting period from the financial statements (all INR except EPS per share). */
export interface StatementPeriod {
  periodEnd: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  ebit: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  freeCashFlow: number | null;
  totalDebt: number | null;
  equity: number | null;
  totalAssets: number | null;
  currentLiabilities: number | null;
}

export interface CompanyProfile {
  symbol: string;
  name: string | null;
  description: string | null;
  sector: string | null;
  industry: string | null;
  website: string | null;
  employees: number | null;
  officers: { name: string; title: string }[];
  exchange: string | null;
  currency: string | null;
  price: number | null;
  priceTime: string | null;
  marketCap: number | null;
  /** Raw provider fields used for metrics (financialData, defaultKeyStatistics, summaryDetail). */
  stats: Record<string, number | undefined>;
}

export interface Announcement {
  date: string;
  subject: string;
  detail?: string;
  link?: string;
}

/** Facts from all sources about one company, before analysis. */
export interface ResearchInputs {
  profile: CompanyProfile;
  annual: StatementPeriod[];
  quarterly: StatementPeriod[];
  candles: Candle[];
  news: NewsArticle[] | null;
  announcements: { items: Announcement[] } | { error: string };
}

export interface Interpretation {
  text: string;
  /** Metrics or facts the statement is based on. */
  basis: string[];
}
