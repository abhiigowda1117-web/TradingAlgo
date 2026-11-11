export interface Candle {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = 'BUY' | 'SELL';

/**
 * Normalised company fundamentals. Ratios are fractions (0.18 = 18%),
 * money values are in INR. Any metric the data source does not report is undefined.
 */
export interface CompanyFundamentals {
  symbol: string;
  name: string;
  sector?: string;
  industry?: string;
  price?: number;
  marketCap?: number;
  pe?: number;
  pb?: number;
  roe?: number;
  roa?: number;
  debtToEquity?: number;
  revenueGrowth?: number;
  earningsGrowth?: number;
  profitMargin?: number;
  operatingMargin?: number;
  currentRatio?: number;
  dividendYield?: number;
  freeCashflow?: number;
  /** Derived from the figures above (see study/derived.ts), not reported by the provider. */
  earningsYield?: number;
  peg?: number;
  peTimesPb?: number;
}

export type MetricKey = Exclude<keyof CompanyFundamentals, 'symbol' | 'name' | 'sector' | 'industry'>;

export interface NewsArticle {
  title: string;
  link: string;
  source?: string;
  publishedAt: Date;
}
