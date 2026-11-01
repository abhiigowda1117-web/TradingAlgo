import { GoogleNews } from '../data/googleNews';
import { createYahooFinance, toYahoo, withRateLimitRetry } from '../data/yahoo';
import { fetchNseAnnouncements } from './nse';
import type { Announcement, Candle, CompanyProfile, NewsArticle, StatementPeriod } from './types';

/** Everything the research module reads from the outside world. Injectable for tests. */
export interface ResearchSources {
  profile(symbol: string): Promise<CompanyProfile>;
  statements(symbol: string): Promise<{ annual: StatementPeriod[]; quarterly: StatementPeriod[] }>;
  candles(symbol: string, from: Date): Promise<Candle[]>;
  news(query: string, since: Date, max: number): Promise<NewsArticle[]>;
  announcements(symbol: string): Promise<Announcement[]>;
}

const num = (x: unknown): number | undefined => {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (x && typeof x === 'object' && 'raw' in x) return num((x as { raw: unknown }).raw);
  return undefined;
};
const nul = (x: unknown): number | null => num(x) ?? null;
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);

/** Yahoo's quoteSummary modules mapped onto a profile. Exported for tests. */
export function mapProfile(symbol: string, qs: Record<string, Record<string, unknown> | undefined>): CompanyProfile {
  const ap = qs.assetProfile ?? {};
  const pr = qs.price ?? {};
  const stats: Record<string, number | undefined> = {};
  for (const mod of ['financialData', 'defaultKeyStatistics', 'summaryDetail'] as const) {
    for (const [k, v] of Object.entries(qs[mod] ?? {})) {
      const n = num(v);
      if (n !== undefined && stats[k] === undefined) stats[k] = n;
    }
  }
  const officers = Array.isArray(ap.companyOfficers) ? (ap.companyOfficers as Record<string, unknown>[]) : [];
  const time = pr.regularMarketTime;
  return {
    symbol,
    name: str(pr.longName) ?? str(pr.shortName),
    description: str(ap.longBusinessSummary),
    sector: str(ap.sector),
    industry: str(ap.industry),
    website: str(ap.website),
    employees: nul(ap.fullTimeEmployees),
    officers: officers.slice(0, 6).flatMap((o) => (str(o.name) ? [{ name: str(o.name)!, title: str(o.title) ?? '' }] : [])),
    exchange: str(pr.exchangeName),
    currency: str(pr.currency),
    price: nul(pr.regularMarketPrice),
    priceTime: time instanceof Date ? time.toISOString() : typeof time === 'number' ? new Date(time * 1000).toISOString() : null,
    marketCap: nul(pr.marketCap) ?? nul(qs.summaryDetail?.marketCap),
    stats,
  };
}

/** One row of Yahoo's fundamentalsTimeSeries ("all" module) mapped onto a statement period. */
export function mapStatement(row: Record<string, unknown>): StatementPeriod {
  const d = row.date instanceof Date ? row.date : new Date(String(row.date));
  const capex = nul(row.capitalExpenditure);
  return {
    periodEnd: d.toISOString().slice(0, 10),
    revenue: nul(row.totalRevenue),
    operatingIncome: nul(row.operatingIncome),
    netIncome: nul(row.netIncome) ?? nul(row.netIncomeCommonStockholders),
    eps: nul(row.dilutedEPS) ?? nul(row.basicEPS),
    ebit: nul(row.EBIT),
    operatingCashFlow: nul(row.operatingCashFlow),
    capex,
    freeCashFlow: nul(row.freeCashFlow),
    totalDebt: nul(row.totalDebt),
    equity: nul(row.stockholdersEquity) ?? nul(row.commonStockEquity),
    totalAssets: nul(row.totalAssets),
    currentLiabilities: nul(row.currentLiabilities),
  };
}

const hasData = (p: StatementPeriod) => Object.entries(p).some(([k, v]) => k !== 'periodEnd' && v !== null);

export class LiveResearchSources implements ResearchSources {
  private yf = createYahooFinance();
  private google = new GoogleNews();

  async profile(symbol: string): Promise<CompanyProfile> {
    const qs = await withRateLimitRetry(`profile ${symbol}`, () =>
      this.yf.quoteSummary(toYahoo(symbol), { modules: ['assetProfile', 'price', 'financialData', 'defaultKeyStatistics', 'summaryDetail'] }, { validateResult: false }),
    );
    return mapProfile(symbol, qs as unknown as Record<string, Record<string, unknown>>);
  }

  async statements(symbol: string) {
    const get = async (type: 'annual' | 'quarterly', years: number) => {
      const rows = await withRateLimitRetry(`${type} statements ${symbol}`, () =>
        this.yf.fundamentalsTimeSeries(toYahoo(symbol), { period1: new Date(Date.now() - years * 365.25 * 86_400_000), type, module: 'all' }, { validateResult: false }),
      );
      return (rows as unknown as Record<string, unknown>[]).map(mapStatement).filter(hasData).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
    };
    return { annual: await get('annual', 6), quarterly: await get('quarterly', 2) };
  }

  async candles(symbol: string, from: Date): Promise<Candle[]> {
    const res = await withRateLimitRetry(`chart ${symbol}`, () => this.yf.chart(toYahoo(symbol), { period1: from, interval: '1d' }));
    return res.quotes
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q) => ({ time: new Date(q.date), open: q.open!, high: q.high!, low: q.low!, close: q.close!, volume: q.volume ?? 0 }));
  }

  news(query: string, since: Date, max: number) {
    return this.google.getNews(query, since, max);
  }

  announcements(symbol: string) {
    return fetchNseAnnouncements(symbol);
  }
}
