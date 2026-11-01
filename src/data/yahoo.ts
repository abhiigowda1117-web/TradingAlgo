import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import YahooFinance from 'yahoo-finance2';
import type { Candle, CompanyFundamentals } from '../types';
import { log } from '../util/log';
import { sleep } from '../util/time';
import type { FundamentalsProvider, MarketData } from './types';

/** Yahoo refused requests because too many were made. Retrying immediately makes it worse. */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export function isRateLimited(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === 429 || /too many requests|\b429\b/i.test(String(err?.message ?? ''));
}

/**
 * Runs a Yahoo call, waiting and retrying when Yahoo rate-limits (HTTP 429). After the last
 * retry it throws RateLimitError so callers can stop instead of hammering Yahoo further.
 */
export async function withRateLimitRetry<T>(what: string, fn: () => Promise<T>, delaysMs: number[] = [10_000, 30_000, 60_000], wait = sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e)) throw e;
      const delay = delaysMs[attempt];
      if (delay === undefined) throw new RateLimitError(`Yahoo is rate-limiting requests (${what}). Wait 15-30 minutes and try again.`);
      log.warn(`Yahoo rate limit on ${what}; waiting ${Math.round(delay / 1000)}s before retry ${attempt + 1}/${delaysMs.length}`);
      await wait(delay);
    }
  }
}

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

type YahooFinanceCtor = typeof YahooFinance;

/**
 * Finds the YahooFinance class whichever build Node loaded. The ESM build's default export is the
 * class; the CommonJS build (loaded e.g. by tsx on Node 26) arrives as `{ default: class }`.
 * yahoo-finance2 v2 exported a ready-made object instead, which means a stale install.
 */
export function resolveYahooCtor(mod: unknown): YahooFinanceCtor {
  let m = mod;
  for (let depth = 0; depth < 4 && m != null; depth++) {
    if (typeof m === 'function') return m as YahooFinanceCtor;
    m = (m as { default?: unknown }).default;
  }
  const found = typeof mod === 'object' && mod ? `an object with keys [${Object.keys(mod).slice(0, 6).join(', ')}]` : typeof mod;
  throw new Error(
    `yahoo-finance2 did not provide the YahooFinance class (got ${found}; installed version ${installedYahooVersion()}). ` +
      'Version 4 is required. In the project folder run: rmdir /s /q node_modules  then  npm install  then  npm ls yahoo-finance2',
  );
}

/** Reads the installed package version straight from node_modules, for error messages. */
function installedYahooVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolvePath(import.meta.dirname, '../../node_modules/yahoo-finance2/package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'not found';
  }
}

function createYahooFinance() {
  const Ctor = resolveYahooCtor(YahooFinance);
  return new Ctor({ suppressNotices: ['yahooSurvey'], queue: { concurrency: 1 } });
}

export class YahooData implements MarketData, FundamentalsProvider {
  // One request at a time: Yahoo rate-limits bursts.
  private yf = createYahooFinance();

  constructor(private exchange: 'NSE' | 'BSE' = 'NSE') {}

  async getDailyCandles(symbol: string, from: Date, to?: Date): Promise<Candle[]> {
    const res = await withRateLimitRetry(`chart ${symbol}`, () =>
      this.yf.chart(toYahoo(symbol, this.exchange), { period1: from, period2: to ?? new Date(), interval: '1d' }),
    );
    return res.quotes
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q) => ({ time: new Date(q.date), open: q.open!, high: q.high!, low: q.low!, close: q.close!, volume: q.volume ?? 0 }));
  }

  async getLtp(symbols: string[]): Promise<Record<string, number>> {
    if (symbols.length === 0) return {};
    const quotes = await withRateLimitRetry(`quote ${symbols.join(',')}`, () => this.yf.quote(symbols.map((s) => toYahoo(s, this.exchange))));
    const out: Record<string, number> = {};
    for (const q of Array.isArray(quotes) ? quotes : [quotes]) {
      const sym = q.symbol.replace(/\.(NS|BO)$/, '');
      if (typeof q.regularMarketPrice === 'number') out[sym] = q.regularMarketPrice;
    }
    return out;
  }

  async getFundamentals(symbol: string): Promise<CompanyFundamentals> {
    const qs = await withRateLimitRetry(`fundamentals ${symbol}`, () =>
      this.yf.quoteSummary(toYahoo(symbol, this.exchange), {
        modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail', 'price', 'assetProfile'],
      }),
    );
    return mapQuoteSummary(symbol, qs as unknown as Record<string, Loose>);
  }
}
