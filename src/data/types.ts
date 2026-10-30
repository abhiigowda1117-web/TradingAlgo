import type { Candle, CompanyFundamentals, NewsArticle } from '../types';

/** Daily candles and last-traded prices for NSE symbols (plain tradingsymbols, e.g. "INFY"). */
export interface MarketData {
  getDailyCandles(symbol: string, from: Date, to?: Date): Promise<Candle[]>;
  getLtp(symbols: string[]): Promise<Record<string, number>>;
}

export interface FundamentalsProvider {
  getFundamentals(symbol: string): Promise<CompanyFundamentals>;
}

export interface NewsProvider {
  getNews(query: string, since: Date, max: number): Promise<NewsArticle[]>;
}
