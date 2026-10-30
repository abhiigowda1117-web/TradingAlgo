import yahooFinance from 'yahoo-finance2';
import type { Candle, CompanyFundamentals } from '../types';
import type { FundamentalsProvider, MarketData } from './types';

yahooFinance.suppressNotices(['yahooSurvey']);

/** NSE tradingsymbol -> Yahoo ticker ("INFY" -> "INFY.NS"). */
export const toYahoo = (symbol: string, exchange: 'NSE' | 'BSE' = 'NSE') => `${symbol}${exchange === 'NSE' ? '.NS' : '.BO'}`;

/** Yahoo returns plain numbers or `{ raw }` objects depending on the module; normalise both. */
function num(x: unknown): number | undefined {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (x && typeof x === 'object' && 'raw' in x) return num((x as { raw: unknown }).raw);
  return undefined;
}

type Loose = Record<string, unknown> | undefined;

/** Maps a Yahoo quoteSummary response onto our fundamentals shape. Exported for tests. */
export function mapQuoteSummary(symbol: string, qs: Record<string, Loose>): CompanyFundamentals {
  const fd = qs.financialData ?? {};
  const ks = qs.defaultKeyStatistics ?? {};
  const sd = qs.summaryDetail ?? {};
  const pr = qs.price ?? {};
  const ap = qs.assetProfile ?? {};
  const de = num(fd.debtToEquity);
  return {
    symbol,
    name: String(pr.longName ?? pr.shortName ?? symbol),
    sector: ap.sector as string | undefined,
    industry: ap.industry as string | undefined,
    price: num(fd.currentPrice) ?? num(pr.regularMarketPrice),
    marketCap: num(pr.marketCap) ?? num(sd.marketCap),
    pe: num(sd.trailingPE) ?? num(ks.trailingPE),
    pb: num(ks.priceToBook),
    roe: num(fd.returnOnEquity),
    roa: num(fd.returnOnAssets),
    // Yahoo reports debt/equity as a percentage (45.2 = 0.452).
    debtToEquity: de === undefined ? undefined : de / 100,
    revenueGrowth: num(fd.revenueGrowth),
    earningsGrowth: num(fd.earningsGrowth),
    profitMargin: num(fd.profitMargins) ?? num(ks.profitMargins),
    operatingMargin: num(fd.operatingMargins),
    currentRatio: num(fd.currentRatio),
    dividendYield: num(sd.dividendYield),
    freeCashflow: num(fd.freeCashflow),
  };
}

export class YahooData implements MarketData, FundamentalsProvider {
  constructor(private exchange: 'NSE' | 'BSE' = 'NSE') {}

  async getDailyCandles(symbol: string, from: Date, to?: Date): Promise<Candle[]> {
    const res = await yahooFinance.chart(toYahoo(symbol, this.exchange), { period1: from, period2: to ?? new Date(), interval: '1d' });
    return res.quotes
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q) => ({ time: new Date(q.date), open: q.open!, high: q.high!, low: q.low!, close: q.close!, volume: q.volume ?? 0 }));
  }

  async getLtp(symbols: string[]): Promise<Record<string, number>> {
    if (symbols.length === 0) return {};
    const quotes = await yahooFinance.quote(symbols.map((s) => toYahoo(s, this.exchange)));
    const out: Record<string, number> = {};
    for (const q of Array.isArray(quotes) ? quotes : [quotes]) {
      const sym = q.symbol.replace(/\.(NS|BO)$/, '');
      if (typeof q.regularMarketPrice === 'number') out[sym] = q.regularMarketPrice;
    }
    return out;
  }

  async getFundamentals(symbol: string): Promise<CompanyFundamentals> {
    const qs = await yahooFinance.quoteSummary(toYahoo(symbol, this.exchange), {
      modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail', 'price', 'assetProfile'],
    });
    return mapQuoteSummary(symbol, qs as unknown as Record<string, Loose>);
  }
}
