import type { ChartYahooInterval, QuoteSnapshot } from '../../research/companyUpdate';
import type { Candle } from '../../research/types';
import { aggregateCandles, KiteError, kiteToSnapshot, yahooToKite, type KiteInterval, type KitePrices } from './kitePrices';

/**
 * Where the website's prices come from. With Zerodha Kite switched on (WEB_MARKET_DATA=kite plus a valid
 * login), prices and candles come from Kite; otherwise from Yahoo Finance (delayed). If Kite fails, the
 * site falls back to Yahoo and says so on the page: nothing is switched silently.
 */

export interface PriceSourceInfo {
  provider: 'kite' | 'yahoo' | 'mixed';
  live: boolean;
  label: string;
  warning?: string;
}

export interface YahooFeed {
  quotes(tickers: string[]): Promise<QuoteSnapshot[]>;
  chart(ticker: string, interval: ChartYahooInterval, from: Date): Promise<Candle[]>;
}

const KITE_INTERVAL: Partial<Record<ChartYahooInterval, KiteInterval>> = { '1m': 'minute', '5m': '5minute', '15m': '15minute', '30m': '30minute', '60m': '60minute', '1d': 'day' };

/** Plain-language reason for a Kite failure, with what to do. Never includes credentials. */
export function kiteProblem(e: unknown): string {
  if (e instanceof KiteError) {
    if (e.type === 'TokenException') return 'Zerodha Kite login has expired (it lasts one day). Run "npm.cmd run kite-login" to log in again';
    if (e.type === 'PermissionException') return 'Your Kite Connect plan does not include this data (charts need the historical-data add-on)';
    if (e.type === 'ConfigError') return 'Kite is switched on but KITE_API_KEY / KITE_ACCESS_TOKEN are missing from .env';
    return `Zerodha Kite error: ${e.message}`;
  }
  return `Zerodha Kite unavailable: ${(e as Error).message}`;
}

export class PriceService {
  /** Most recent Kite problem, shown on the page while Yahoo is used instead. Cleared after a Kite success. */
  kiteWarning: string | undefined;

  constructor(
    private yahoo: YahooFeed,
    private kite: KitePrices | null,
  ) {}

  get kiteEnabled() {
    return this.kite !== null;
  }

  /**
   * Quotes for Yahoo-style tickers. With Kite: prices from Kite; the fields Kite does not have (company
   * name, 52-week range, market cap, P/E) are filled from Yahoo. Tickers Kite does not return are taken
   * from Yahoo and marked as such.
   */
  async quotes(tickers: string[]): Promise<QuoteSnapshot[]> {
    if (!this.kite) return (await this.yahoo.quotes(tickers)).map((q) => ({ ...q, source: 'yahoo' as const }));
    const map = new Map(tickers.map((t) => [t, yahooToKite(t)]));
    let kq: Awaited<ReturnType<KitePrices['quote']>>;
    try {
      kq = await this.kite.quote([...new Set([...map.values()].filter((x): x is string => x !== null))]);
      this.kiteWarning = undefined;
    } catch (e) {
      this.kiteWarning = kiteProblem(e);
      return (await this.yahoo.quotes(tickers)).map((q) => ({ ...q, source: 'yahoo' as const }));
    }
    const extra = new Map((await this.yahoo.quotes(tickers).catch(() => [] as QuoteSnapshot[])).map((q) => [q.ticker, q]));
    const out: QuoteSnapshot[] = [];
    for (const t of tickers) {
      const k = map.get(t);
      const y = extra.get(t);
      if (k && kq[k]) {
        const s = kiteToSnapshot(t, kq[k]!);
        out.push({ ...s, name: y?.name ?? null, high52: y?.high52 ?? null, low52: y?.low52 ?? null, marketCap: y?.marketCap ?? null, pe: y?.pe ?? null, avgVolume3m: y?.avgVolume3m ?? null });
      } else if (y) out.push({ ...y, source: 'yahoo' });
    }
    return out;
  }

  /** Chart candles from Kite (weekly/monthly built from Kite daily candles), else Yahoo, with the source. */
  async chart(ticker: string, interval: ChartYahooInterval, from: Date): Promise<{ rows: Candle[]; provider: 'kite' | 'yahoo'; warning?: string; note?: string }> {
    const instrument = yahooToKite(ticker);
    if (this.kite && instrument) {
      try {
        if (interval === '1wk' || interval === '1mo') {
          const daily = await this.kite.historical(instrument, 'day', from);
          return { rows: aggregateCandles(daily, interval === '1wk' ? 'week' : 'month'), provider: 'kite', note: `${interval === '1wk' ? 'Weekly' : 'Monthly'} candles are built from Kite daily candles.` };
        }
        return { rows: await this.kite.historical(instrument, KITE_INTERVAL[interval]!, from), provider: 'kite' };
      } catch (e) {
        const warning = kiteProblem(e);
        return { rows: await this.yahoo.chart(ticker, interval, from), provider: 'yahoo', warning };
      }
    }
    return { rows: await this.yahoo.chart(ticker, interval, from), provider: 'yahoo' };
  }
}

/** Describes the source of a set of quotes for the page. */
export function describeQuotes(rows: QuoteSnapshot[], warning?: string): PriceSourceInfo {
  const kite = rows.filter((r) => r.source === 'kite').length;
  if (kite === 0) {
    return { provider: 'yahoo', live: false, label: 'Yahoo Finance, delayed by about 15 minutes; not real-time.', ...(warning ? { warning: `${warning}. Showing Yahoo Finance (delayed) instead.` } : {}) };
  }
  if (kite === rows.length) return { provider: 'kite', live: true, label: 'Prices from Zerodha Kite (exchange data).' };
  return { provider: 'mixed', live: true, label: `Zerodha Kite for ${kite} of ${rows.length} items; the rest from Yahoo Finance (delayed about 15 minutes).` };
}
