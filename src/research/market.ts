import { isNseOpen, istParts } from '../util/time';
import type { QuoteSnapshot } from './companyUpdate';

/** Market overview: index levels, NSE session status and how a list of stocks is moving. Read-only. */

export const INDICES: { ticker: string; label: string; group: 'Broad' | 'Sector' | 'Volatility' }[] = [
  { ticker: '^NSEI', label: 'NIFTY 50', group: 'Broad' },
  { ticker: '^BSESN', label: 'SENSEX', group: 'Broad' },
  { ticker: '^NSEBANK', label: 'NIFTY Bank', group: 'Sector' },
  { ticker: '^CNXIT', label: 'NIFTY IT', group: 'Sector' },
  { ticker: '^CNXPHARMA', label: 'NIFTY Pharma', group: 'Sector' },
  { ticker: '^CNXFMCG', label: 'NIFTY FMCG', group: 'Sector' },
  { ticker: '^CNXAUTO', label: 'NIFTY Auto', group: 'Sector' },
  { ticker: '^CNXMETAL', label: 'NIFTY Metal', group: 'Sector' },
  { ticker: '^CNXENERGY', label: 'NIFTY Energy', group: 'Sector' },
  { ticker: '^CNXREALTY', label: 'NIFTY Realty', group: 'Sector' },
  { ticker: '^INDIAVIX', label: 'India VIX', group: 'Volatility' },
];

export interface MarketSources {
  quotes(tickers: string[]): Promise<QuoteSnapshot[]>;
}

export interface IndexRow {
  ticker: string;
  label: string;
  group: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  high52: number | null;
  low52: number | null;
  time: string | null;
}

export interface StockRow {
  symbol: string;
  name: string | null;
  price: number | null;
  changePct: number | null;
  /** Where the price sits in its 52-week range, 0 (at the low) to 1 (at the high). */
  range52: number | null;
}

export interface MarketOverview {
  generatedAt: string;
  session: { open: boolean; label: string; istTime: string; holiday: boolean };
  indices: IndexRow[];
  stocks: StockRow[];
  breadth: { advancers: number; decliners: number; unchanged: number; unavailable: number } | null;
  /** Interpretation, rule-based. */
  summary: string[];
  dataNote: string;
}

/**
 * Large NSE companies scanned for the movers board. A fixed list of about 50 well-known large caps; it is
 * close to, but not guaranteed to match, the current NIFTY 50 (index members change twice a year).
 * Symbols Yahoo cannot price are skipped and counted as unavailable.
 */
export const LARGE_CAPS = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'BHARTIARTL', 'ITC', 'SBIN', 'LT', 'HINDUNILVR',
  'KOTAKBANK', 'AXISBANK', 'BAJFINANCE', 'MARUTI', 'SUNPHARMA', 'HCLTECH', 'M&M', 'TITAN', 'ASIANPAINT', 'ULTRACEMCO',
  'NTPC', 'POWERGRID', 'TATASTEEL', 'NESTLEIND', 'WIPRO', 'ONGC', 'ADANIPORTS', 'COALINDIA', 'JSWSTEEL', 'BAJAJFINSV',
  'TECHM', 'HINDALCO', 'GRASIM', 'CIPLA', 'DRREDDY', 'EICHERMOT', 'HEROMOTOCO', 'BAJAJ-AUTO', 'APOLLOHOSP', 'TATACONSUM',
  'TRENT', 'BEL', 'ADANIENT', 'HDFCLIFE', 'SBILIFE', 'SHRIRAMFIN', 'JIOFIN', 'ETERNAL', 'INDIGO', 'MAXHEALTH',
];

export interface MoverRow {
  symbol: string;
  name: string | null;
  price: number;
  change: number | null;
  changePct: number;
}

export interface MarketMovers {
  generatedAt: string;
  session: MarketOverview['session'];
  /** Biggest percentage rises today, largest first. Only stocks that are up. */
  gainers: MoverRow[];
  /** Biggest percentage falls today, largest fall first. Only stocks that are down. */
  losers: MoverRow[];
  /** Every priced stock, alphabetical, for the scrolling ticker tape. */
  tape: MoverRow[];
  scanned: number;
  unavailable: number;
  /** Latest quote time among the stocks (ISO), or null. */
  quoteTime: string | null;
  dataNote: string;
}

/** Top gainers and losers among a list of NSE symbols, from one batch of delayed quotes. Describes; does not predict. */
export async function marketMovers(src: MarketSources, o: { symbols: string[]; holidays: string[]; now?: Date; count?: number }): Promise<MarketMovers> {
  const now = o.now ?? new Date();
  const count = o.count ?? 8;
  const quotes = await src.quotes(o.symbols.map((s) => `${s}.NS`));
  const byTicker = new Map(quotes.map((q) => [q.ticker, q]));
  const rows: MoverRow[] = [];
  for (const s of o.symbols) {
    const q = byTicker.get(`${s}.NS`);
    if (!q || q.price === null || q.changePct === null || !Number.isFinite(q.price) || !Number.isFinite(q.changePct)) continue;
    rows.push({ symbol: s, name: q.name, price: q.price, change: q.change, changePct: q.changePct });
  }
  const times = quotes.map((q) => q.time).filter((t): t is string => typeof t === 'string').sort();
  return {
    generatedAt: now.toISOString(),
    session: sessionStatus(now, o.holidays),
    gainers: rows.filter((r) => r.changePct > 0).sort((a, b) => b.changePct - a.changePct || a.symbol.localeCompare(b.symbol)).slice(0, count),
    losers: rows.filter((r) => r.changePct < 0).sort((a, b) => a.changePct - b.changePct || a.symbol.localeCompare(b.symbol)).slice(0, count),
    tape: [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    scanned: o.symbols.length,
    unavailable: o.symbols.length - rows.length,
    quoteTime: times.at(-1) ?? null,
    dataNote: `Scans ${o.symbols.length} large NSE companies (close to the NIFTY 50 list). Quotes from Yahoo Finance, delayed by about 15 minutes; not real-time.`,
  };
}

export function sessionStatus(now: Date, holidays: string[]): MarketOverview['session'] {
  const t = istParts(now);
  const open = isNseOpen(now, holidays);
  const holiday = holidays.includes(t.date);
  const weekend = t.weekday === 0 || t.weekday === 6;
  const hh = `${String(Math.floor(t.minutes / 60)).padStart(2, '0')}:${String(t.minutes % 60).padStart(2, '0')}`;
  const label = open
    ? 'NSE is open (09:15–15:30 IST)'
    : holiday
      ? 'NSE holiday (from config/trading.json)'
      : weekend
        ? 'Weekend: NSE is closed'
        : t.minutes < 9 * 60 + 15
          ? 'Before market open (opens 09:15 IST)'
          : 'Market closed for the day (closed 15:30 IST)';
  return { open, label, istTime: `${t.date} ${hh} IST`, holiday };
}

export async function marketOverview(src: MarketSources, o: { watchlist: string[]; holidays: string[]; now?: Date }): Promise<MarketOverview> {
  const now = o.now ?? new Date();
  const stockTickers = o.watchlist.map((s) => `${s}.NS`);
  const quotes = await src.quotes([...INDICES.map((i) => i.ticker), ...stockTickers]);
  const byTicker = new Map(quotes.map((q) => [q.ticker, q]));

  const indices: IndexRow[] = INDICES.map((i) => {
    const q = byTicker.get(i.ticker);
    return {
      ticker: i.ticker,
      label: i.label,
      group: i.group,
      price: q?.price ?? null,
      change: q?.change ?? null,
      changePct: q?.changePct ?? null,
      dayLow: q?.dayLow ?? null,
      dayHigh: q?.dayHigh ?? null,
      high52: q?.high52 ?? null,
      low52: q?.low52 ?? null,
      time: q?.time ?? null,
    };
  });

  const stocks: StockRow[] = o.watchlist.map((s) => {
    const q = byTicker.get(`${s}.NS`);
    const range52 = q && q.price !== null && q.high52 !== null && q.low52 !== null && q.high52 > q.low52 ? (q.price - q.low52) / (q.high52 - q.low52) : null;
    return { symbol: s, name: q?.name ?? null, price: q?.price ?? null, changePct: q?.changePct ?? null, range52 };
  });

  const known = stocks.filter((s) => s.changePct !== null);
  const breadth = stocks.length
    ? {
        advancers: known.filter((s) => s.changePct! > 0.05).length,
        decliners: known.filter((s) => s.changePct! < -0.05).length,
        unchanged: known.filter((s) => Math.abs(s.changePct!) <= 0.05).length,
        unavailable: stocks.length - known.length,
      }
    : null;

  return { generatedAt: now.toISOString(), session: sessionStatus(now, o.holidays), indices, stocks, breadth, summary: summarize(indices, breadth), dataNote: 'Quotes from Yahoo Finance, delayed by about 15 minutes; not real-time. Index tickers that fail show Not Available.' };
}

/** Rule-based reading of the day. Describes, does not predict. */
export function summarize(indices: IndexRow[], breadth: MarketOverview['breadth']): string[] {
  const out: string[] = [];
  const nifty = indices.find((i) => i.ticker === '^NSEI');
  if (nifty?.changePct != null) {
    const c = nifty.changePct;
    out.push(`NIFTY 50 is ${c > 0.75 ? 'strongly up' : c > 0.15 ? 'up' : c < -0.75 ? 'sharply down' : c < -0.15 ? 'down' : 'flat'} today (${c >= 0 ? '+' : ''}${c.toFixed(2)}%).`);
    if (nifty.price !== null && nifty.high52 !== null && nifty.low52 !== null && nifty.high52 > nifty.low52) {
      const pos = (nifty.price - nifty.low52) / (nifty.high52 - nifty.low52);
      out.push(`NIFTY 50 is at ${(pos * 100).toFixed(0)}% of its 52-week range (${pos > 0.8 ? 'near the high' : pos < 0.2 ? 'near the low' : 'mid-range'}).`);
    }
  }
  const sectors = indices.filter((i) => i.group === 'Sector' && i.changePct !== null).sort((a, b) => b.changePct! - a.changePct!);
  if (sectors.length >= 2) {
    out.push(`Strongest sector: ${sectors[0]!.label} (${sectors[0]!.changePct! >= 0 ? '+' : ''}${sectors[0]!.changePct!.toFixed(2)}%). Weakest: ${sectors.at(-1)!.label} (${sectors.at(-1)!.changePct!.toFixed(2)}%).`);
  }
  const vix = indices.find((i) => i.ticker === '^INDIAVIX');
  if (vix?.price != null) out.push(`India VIX is ${vix.price.toFixed(1)}: ${vix.price > 20 ? 'elevated expected volatility' : vix.price < 13 ? 'low expected volatility' : 'normal expected volatility'}.`);
  if (breadth && breadth.advancers + breadth.decliners > 0) out.push(`Watchlist breadth: ${breadth.advancers} up, ${breadth.decliners} down${breadth.unchanged ? `, ${breadth.unchanged} flat` : ''}.`);
  if (!out.length) out.push('Not enough data for a summary.');
  return out;
}
