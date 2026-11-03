import type { QuoteSnapshot } from '../../research/companyUpdate';
import type { Candle } from '../../research/types';

/**
 * Read-only Zerodha Kite Connect client for the website's prices and charts.
 *
 * It can only call two GET endpoints: /quote and /instruments/historical. It has no order, position or
 * funds code, so the web server cannot place trades through it. Credentials stay on the server: they are
 * sent only to api.kite.trade in the Authorization header and are never logged or returned to the browser.
 */

const BASE = 'https://api.kite.trade';

export class KiteError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface KiteQuote {
  instrument_token: number;
  timestamp?: string;
  last_trade_time?: string;
  last_price: number;
  volume?: number;
  ohlc?: { open: number; high: number; low: number; close: number };
}

export type KiteInterval = 'minute' | '5minute' | '15minute' | '30minute' | '60minute' | 'day';

/** Kite's maximum days per historical request, by interval. */
export const KITE_MAX_DAYS: Record<KiteInterval, number> = { minute: 60, '5minute': 100, '15minute': 200, '30minute': 200, '60minute': 400, day: 2000 };

export interface KiteCredentials {
  apiKey: string;
  accessToken: string;
}

/** Yahoo ticker -> Kite instrument ("INFY.NS" -> "NSE:INFY", "^NSEI" -> "NSE:NIFTY 50"). Null if unknown. */
const INDEX_MAP: Record<string, string> = {
  '^NSEI': 'NSE:NIFTY 50',
  '^BSESN': 'BSE:SENSEX',
  '^NSEBANK': 'NSE:NIFTY BANK',
  '^CNXIT': 'NSE:NIFTY IT',
  '^CNXPHARMA': 'NSE:NIFTY PHARMA',
  '^CNXFMCG': 'NSE:NIFTY FMCG',
  '^CNXAUTO': 'NSE:NIFTY AUTO',
  '^CNXMETAL': 'NSE:NIFTY METAL',
  '^CNXENERGY': 'NSE:NIFTY ENERGY',
  '^CNXREALTY': 'NSE:NIFTY REALTY',
  '^INDIAVIX': 'NSE:INDIA VIX',
};
export function yahooToKite(ticker: string): string | null {
  if (INDEX_MAP[ticker]) return INDEX_MAP[ticker]!;
  const m = /^([A-Z0-9&-]{1,20})\.(NS|BO)$/.exec(ticker);
  return m ? `${m[2] === 'NS' ? 'NSE' : 'BSE'}:${m[1]}` : null;
}

/** Kite times are IST without a zone ("2026-11-03 15:29:59") or with "+0530"; returns ISO UTC. */
export function kiteTime(t: string | undefined): string | null {
  if (!t) return null;
  const s = /[+-]\d{2}:?\d{2}$|Z$/.test(t) ? t.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : `${t.replace(' ', 'T')}+05:30`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Kite quote -> the app's quote shape. Fields Kite does not provide (name, 52-week range, P/E...) are null. */
export function kiteToSnapshot(ticker: string, q: KiteQuote): QuoteSnapshot {
  const prev = q.ohlc?.close ?? null;
  const change = prev !== null && prev > 0 ? q.last_price - prev : null;
  return {
    ticker,
    name: null,
    price: q.last_price,
    change,
    changePct: change !== null && prev ? (change / prev) * 100 : null,
    previousClose: prev,
    open: q.ohlc?.open || null,
    dayHigh: q.ohlc?.high || null,
    dayLow: q.ohlc?.low || null,
    volume: q.volume ?? null,
    avgVolume3m: null,
    high52: null,
    low52: null,
    marketCap: null,
    pe: null,
    time: kiteTime(q.last_trade_time ?? q.timestamp),
    marketState: null,
    source: 'kite',
  };
}

/** IST wall-clock "yyyy-mm-dd hh:mm:ss", which is what Kite's historical API expects. */
export const istStamp = (d: Date) => new Date(d.getTime() + 19_800_000).toISOString().slice(0, 19).replace('T', ' ');

export class KitePrices {
  private tokens = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;

  constructor(
    private creds: () => KiteCredentials | null,
    private fetchImpl: typeof fetch = fetch,
    /** Minimum gap between requests; Kite allows about 1 quote request per second. */
    private gapMs = 1100,
  ) {}

  /** Requests run one at a time with a small gap, to stay inside Kite's rate limits. */
  private get<T>(path: string, params: [string, string][]): Promise<T> {
    const run = async () => {
      const wait = this.lastCall + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      const c = this.creds();
      if (!c) throw new KiteError('ConfigError', 'KITE_API_KEY and KITE_ACCESS_TOKEN are not set in .env', 0);
      const url = `${BASE}${path}?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
      const res = await this.fetchImpl(url, { headers: { 'X-Kite-Version': '3', Authorization: `token ${c.apiKey}:${c.accessToken}` } });
      let body: { status?: string; message?: string; error_type?: string; data?: T };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new KiteError('NetworkException', `Kite returned HTTP ${res.status} without JSON`, res.status);
      }
      if (!res.ok || body.status !== 'success' || body.data === undefined) {
        throw new KiteError(body.error_type ?? 'GeneralException', body.message ?? `Kite returned HTTP ${res.status}`, res.status);
      }
      return body.data;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p as Promise<T>;
  }

  /** Full quotes for up to any number of instruments ("NSE:INFY"), 500 per request. */
  async quote(instruments: string[]): Promise<Record<string, KiteQuote>> {
    const out: Record<string, KiteQuote> = {};
    for (let i = 0; i < instruments.length; i += 500) {
      const part = await this.get<Record<string, KiteQuote>>('/quote', instruments.slice(i, i + 500).map((x) => ['i', x]));
      Object.assign(out, part);
      for (const [k, v] of Object.entries(part)) this.tokens.set(k, v.instrument_token);
    }
    return out;
  }

  async instrumentToken(instrument: string): Promise<number> {
    if (!this.tokens.has(instrument)) await this.quote([instrument]);
    const t = this.tokens.get(instrument);
    if (t === undefined) throw new KiteError('InputException', `Kite does not know ${instrument}`, 400);
    return t;
  }

  /** Historical candles (needs the Kite historical-data add-on), fetched in chunks within Kite's limits. */
  async historical(instrument: string, interval: KiteInterval, from: Date, to: Date = new Date()): Promise<Candle[]> {
    const token = await this.instrumentToken(instrument);
    const out: Candle[] = [];
    const span = KITE_MAX_DAYS[interval] * 86_400_000;
    for (let start = from.getTime(); start < to.getTime(); start += span) {
      const end = Math.min(start + span - 1000, to.getTime());
      const data = await this.get<{ candles: [string, number, number, number, number, number?][] }>(`/instruments/historical/${token}/${interval}`, [
        ['from', istStamp(new Date(start))],
        ['to', istStamp(new Date(end))],
      ]);
      for (const [t, open, high, low, close, volume] of data.candles) {
        const iso = kiteTime(t);
        if (iso) out.push({ time: new Date(iso), open, high, low, close, volume: volume ?? 0 });
      }
    }
    return out;
  }
}

/** Weekly (Monday-start) or monthly candles from daily candles, grouped by IST calendar date. */
export function aggregateCandles(daily: Candle[], by: 'week' | 'month'): Candle[] {
  const groups = new Map<string, Candle>();
  for (const c of [...daily].sort((a, b) => a.time.getTime() - b.time.getTime())) {
    const ist = new Date(c.time.getTime() + 19_800_000);
    let key: string;
    if (by === 'month') key = ist.toISOString().slice(0, 7);
    else {
      const monday = new Date(ist);
      monday.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() + 6) % 7));
      key = monday.toISOString().slice(0, 10);
    }
    const g = groups.get(key);
    if (!g) groups.set(key, { ...c });
    else {
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += c.volume;
    }
  }
  return [...groups.values()];
}
