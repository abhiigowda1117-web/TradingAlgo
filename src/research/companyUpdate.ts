import { GoogleNews } from '../data/googleNews';
import { createYahooFinance, withRateLimitRetry } from '../data/yahoo';
import { newsQueryName } from '../study/study';
import { classifyNews, type ClassifiedNews } from './news';
import { fetchNseAnnouncements, officialLinks } from './nse';
import { analyzeTechnicals, type TechnicalSection } from './technicals';
import type { Announcement, Candle, NewsArticle } from './types';

/** A quick "what's happening today" view of one company. Read-only; no trading code involved. */

export type ChartYahooInterval = '1m' | '5m' | '15m' | '30m' | '60m' | '1d' | '1wk' | '1mo';

export interface QuoteSnapshot {
  ticker: string;
  name: string | null;
  price: number | null;
  change: number | null;
  changePct: number | null;
  previousClose: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  avgVolume3m: number | null;
  high52: number | null;
  low52: number | null;
  marketCap: number | null;
  pe: number | null;
  time: string | null;
  marketState: string | null;
  /** Which provider priced this row, when known (the website can use Zerodha Kite or Yahoo Finance). */
  source?: 'kite' | 'yahoo';
}

export interface SearchHit {
  symbol: string;
  name: string | null;
  exchange: string | null;
}

export interface UpdateSources {
  quote(ticker: string): Promise<QuoteSnapshot | null>;
  search(query: string): Promise<SearchHit[]>;
  candles(ticker: string, from: Date): Promise<Candle[]>;
  news(query: string, since: Date, max: number): Promise<NewsArticle[]>;
  announcements(symbol: string): Promise<Announcement[]>;
}

const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const SYMBOL = /^[A-Z0-9&-]{1,20}$/;

/** Maps a Yahoo quote object onto a snapshot. Exported for tests. */
export function mapQuote(q: Record<string, unknown>): QuoteSnapshot {
  const t = q.regularMarketTime;
  return {
    ticker: String(q.symbol ?? ''),
    name: (q.longName as string) || (q.shortName as string) || null,
    price: n(q.regularMarketPrice),
    change: n(q.regularMarketChange),
    // Yahoo gives this already in percent (1.5 = 1.5%).
    changePct: n(q.regularMarketChangePercent),
    previousClose: n(q.regularMarketPreviousClose),
    open: n(q.regularMarketOpen),
    dayHigh: n(q.regularMarketDayHigh),
    dayLow: n(q.regularMarketDayLow),
    volume: n(q.regularMarketVolume),
    avgVolume3m: n(q.averageDailyVolume3Month),
    high52: n(q.fiftyTwoWeekHigh),
    low52: n(q.fiftyTwoWeekLow),
    marketCap: n(q.marketCap),
    pe: n(q.trailingPE),
    time: t instanceof Date ? t.toISOString() : typeof t === 'number' ? new Date(t * 1000).toISOString() : null,
    marketState: typeof q.marketState === 'string' ? q.marketState : null,
  };
}

/**
 * Turns what the user typed into an NSE ticker. A plain symbol ("RELIANCE", "BAJAJ-AUTO") is tried
 * directly on NSE; otherwise (or if that has no price) Yahoo search is used, preferring NSE (.NS)
 * listings over BSE (.BO).
 */
export async function resolveCompany(input: string, src: UpdateSources): Promise<{ ticker: string; symbol: string; quote: QuoteSnapshot; matchedBy: string }> {
  const raw = input.trim();
  if (!raw) throw new Error('Type a company name or NSE symbol, e.g. Reliance or RELIANCE');
  const upper = raw.toUpperCase();
  if (SYMBOL.test(upper)) {
    const q = await src.quote(`${upper}.NS`).catch(() => null);
    if (q && q.price !== null) return { ticker: `${upper}.NS`, symbol: upper, quote: q, matchedBy: 'NSE symbol' };
  }
  const indian = (q: string) => src.search(q).then((r) => r.filter((h) => /\.(NS|BO)$/.test(h.symbol)));
  let hits = await indian(raw);
  // "Suraksha Diagnostic Ltd" -> also try "Suraksha Diagnostic": suffixes like Ltd/Limited often spoil the search.
  const short = raw.replace(/[\s.,]+(ltd|limited|pvt|private|inc|corp(oration)?|co|company)\.?$/gi, '').replace(/[\s.,]+(ltd|limited|pvt|private)\.?$/gi, '').trim();
  if (!hits.length && short && short !== raw) hits = await indian(short);
  const best = hits.find((h) => h.symbol.endsWith('.NS')) ?? hits[0];
  if (!best) throw new Error(`No NSE/BSE listed company found for "${raw}". Try the exact NSE symbol (e.g. RELIANCE, BEL, HDFCBANK).`);
  const q = await src.quote(best.symbol);
  if (!q || q.price === null) throw new Error(`Found ${best.symbol} for "${raw}" but no price is available right now.`);
  return { ticker: best.symbol, symbol: best.symbol.replace(/\.(NS|BO)$/, ''), quote: q, matchedBy: `search "${raw}"${hits.length > 1 ? ` (best of ${hits.length} matches)` : ''}` };
}

export interface CompanyUpdate {
  input: string;
  symbol: string;
  ticker: string;
  matchedBy: string;
  quote: QuoteSnapshot;
  technicals: TechnicalSection | null;
  news: ClassifiedNews[] | null;
  newsDays: number;
  announcements: { items: Announcement[] } | { error: string };
  links: { label: string; url: string }[];
  warnings: string[];
  generatedAt: string;
}

export async function companyUpdate(input: string, src: UpdateSources, o: { newsDays?: number; now?: Date } = {}): Promise<CompanyUpdate> {
  const now = o.now ?? new Date();
  const newsDays = o.newsDays ?? 3;
  const { ticker, symbol, quote, matchedBy } = await resolveCompany(input, src);
  const warnings: string[] = [];

  let technicals: TechnicalSection | null = null;
  try {
    const c = await src.candles(ticker, new Date(now.getTime() - 400 * 86_400_000));
    if (c.length) technicals = analyzeTechnicals(c);
  } catch (e) {
    warnings.push(`Price history unavailable: ${(e as Error).message}`);
  }

  let news: ClassifiedNews[] | null = null;
  try {
    const name = newsQueryName(quote.name ?? symbol);
    news = classifyNews(await src.news(`"${name}"`, new Date(now.getTime() - newsDays * 86_400_000), 10));
  } catch (e) {
    warnings.push(`News unavailable: ${(e as Error).message}`);
  }

  let announcements: CompanyUpdate['announcements'];
  if (ticker.endsWith('.NS')) {
    try {
      announcements = { items: (await src.announcements(symbol)).slice(0, 5) };
    } catch (e) {
      announcements = { error: (e as Error).message };
    }
  } else announcements = { error: 'BSE-only listing; NSE announcements not applicable' };

  return { input, symbol, ticker, matchedBy, quote, technicals, news, newsDays, announcements, links: officialLinks(symbol).slice(0, 2), warnings, generatedAt: now.toISOString() };
}

// ---------------------------------------------------------------- terminal output

const NA = 'Not Available';
const rupee = (x: number | null, dp = 2) => (x === null ? NA : `₹${x.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const crore = (x: number | null) => (x === null ? NA : `₹${(x / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`);
const signed = (x: number | null, suffix = '') => (x === null ? NA : `${x >= 0 ? '+' : ''}${x.toFixed(2)}${suffix}`);
const ist = (iso: string | null) =>
  iso === null ? 'time unknown' : new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';

/** Plain-text report for the Command Prompt. */
export function formatUpdate(u: CompanyUpdate): string {
  const q = u.quote;
  const t = u.technicals;
  const L: string[] = [];
  const line = '─'.repeat(64);
  L.push(line, `${u.symbol}  ·  ${q.name ?? NA}  (${u.ticker.endsWith('.NS') ? 'NSE' : 'BSE'})`, line);
  L.push(`Price        ${rupee(q.price)}   ${signed(q.change)}  (${signed(q.changePct, '%')})`);
  L.push(`As of        ${ist(q.time)}${q.marketState ? `  [market ${q.marketState.toLowerCase()}]` : ''}  — delayed, not real-time`);
  L.push(`Open / Prev  ${rupee(q.open)}  /  ${rupee(q.previousClose)}`);
  L.push(`Day range    ${rupee(q.dayLow)}  –  ${rupee(q.dayHigh)}`);
  const volRatio = q.volume !== null && q.avgVolume3m ? q.volume / q.avgVolume3m : null;
  L.push(`Volume       ${q.volume === null ? NA : q.volume.toLocaleString('en-IN')}${volRatio !== null ? `  (${volRatio.toFixed(1)}× the 3-month average)` : ''}`);
  const pos52 = q.price !== null && q.high52 !== null && q.low52 !== null && q.high52 > q.low52 ? (q.price - q.low52) / (q.high52 - q.low52) : null;
  L.push(`52-week      ${rupee(q.low52)}  –  ${rupee(q.high52)}${pos52 !== null ? `  (now at ${(pos52 * 100).toFixed(0)}% of the range)` : ''}`);
  L.push(`Market cap   ${crore(q.marketCap)}     P/E ${q.pe === null ? NA : q.pe.toFixed(1)}`);

  L.push('', 'TREND (daily, calculated)');
  if (!t) L.push(`  ${NA}`);
  else {
    const vs = (v: number | null, label: string) => (v === null || t.lastClose === null ? `${label} ${NA}` : `${t.lastClose > v ? 'above' : 'below'} ${label} (${rupee(v)})`);
    L.push(`  ${t.trend.trend}: ${t.trend.reason}`);
    L.push(`  Price is ${vs(t.ema20, 'EMA20')}, ${vs(t.ema50, 'EMA50')}, ${vs(t.ema200, 'EMA200')}`);
    L.push(`  RSI(14) ${t.rsi14 === null ? NA : t.rsi14.toFixed(1)}${t.rsi14 !== null ? (t.rsi14 > 70 ? ' (overbought zone)' : t.rsi14 < 30 ? ' (oversold zone)' : ' (neutral)') : ''}   ·   ${t.macd.state}`);
    L.push(`  Returns: ${t.returns.map((r) => `${r.label} ${r.value === null ? NA : signed(r.value * 100, '%')}`).join('  ·  ')}`);
    if (t.supports[0] || t.resistances[0]) L.push(`  Nearest support ${t.supports[0] ? rupee(t.supports[0].price) : NA}  ·  nearest resistance ${t.resistances[0] ? rupee(t.resistances[0].price) : NA}`);
  }

  L.push('', `NEWS (last ${u.newsDays} days, Google News — publishers, not official)`);
  if (u.news === null) L.push(`  ${NA}`);
  else if (!u.news.length) L.push('  No headlines found in this period.');
  else for (const x of u.news) L.push(`  ${x.date}  [${x.category}${x.sentiment > 0.2 ? ', positive' : x.sentiment < -0.2 ? ', negative' : ''}]  ${x.title}${x.source ? ` — ${x.source}` : ''}`);

  L.push('', 'NSE ANNOUNCEMENTS (official disclosures)');
  if ('items' in u.announcements && u.announcements.items.length) {
    for (const a of u.announcements.items) L.push(`  ${a.date}  ${a.subject}${a.detail ? `: ${a.detail.slice(0, 100)}` : ''}`);
  } else L.push(`  ${NA}${'error' in u.announcements ? ` (${u.announcements.error})` : ''}. Check: ${u.links[0]?.url ?? ''}`);

  if (u.warnings.length) L.push('', ...u.warnings.map((w) => `Note: ${w}`));
  L.push('', `Matched by ${u.matchedBy}. Data: Yahoo Finance, Google News, NSE. Information only — not investment advice.`);
  L.push(`Full report: npm run research -- ${u.symbol}`, line);
  return L.join('\n');
}

// ---------------------------------------------------------------- live sources

export class LiveUpdateSources implements UpdateSources {
  private yf = createYahooFinance();
  private google = new GoogleNews();

  async quote(ticker: string) {
    const q = await withRateLimitRetry(`quote ${ticker}`, () => this.yf.quote(ticker, {}, { validateResult: false }));
    const one = Array.isArray(q) ? q[0] : q;
    return one ? mapQuote(one as unknown as Record<string, unknown>) : null;
  }

  /** Several tickers in one request (used by the market overview). Missing tickers are simply absent. */
  async quotes(tickers: string[]) {
    if (!tickers.length) return [];
    const q = await withRateLimitRetry(`quotes (${tickers.length})`, () => this.yf.quote(tickers, {}, { validateResult: false }));
    return (Array.isArray(q) ? q : [q]).map((x) => mapQuote(x as unknown as Record<string, unknown>));
  }

  async search(query: string) {
    const r = await withRateLimitRetry(`search ${query}`, () => this.yf.search(query, { quotesCount: 10, newsCount: 0 }, { validateResult: false }));
    const quotes = ((r as unknown as { quotes?: Record<string, unknown>[] }).quotes ?? []).filter((x) => typeof x.symbol === 'string');
    return quotes.map((x) => ({ symbol: x.symbol as string, name: ((x.longname ?? x.shortname) as string) ?? null, exchange: (x.exchange as string) ?? null }));
  }

  async candles(ticker: string, from: Date) {
    const res = await withRateLimitRetry(`chart ${ticker}`, () => this.yf.chart(ticker, { period1: from, interval: '1d' }));
    return res.quotes
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q) => ({ time: new Date(q.date), open: q.open!, high: q.high!, low: q.low!, close: q.close!, volume: q.volume ?? 0 }));
  }

  /** Candles at any Yahoo interval (1m ... 1mo) from `from` until now, for the interactive chart. */
  async chart(ticker: string, interval: ChartYahooInterval, from: Date): Promise<Candle[]> {
    const res = await withRateLimitRetry(`chart ${ticker} ${interval}`, () => this.yf.chart(ticker, { period1: from, interval }));
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
