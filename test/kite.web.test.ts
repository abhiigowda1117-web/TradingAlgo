import { describe, expect, it } from 'vitest';
import type { QuoteSnapshot } from '../src/research/companyUpdate';
import { apiRoutes } from '../src/server/routes';
import { aggregateCandles, istStamp, KiteError, KitePrices, kiteTime, kiteToSnapshot, yahooToKite } from '../src/server/services/kitePrices';
import { describeQuotes, kiteProblem, PriceService } from '../src/server/services/prices';
import { setEnvValue } from '../src/util/envFile';
import { tradingCfg } from './helpers';

const CREDS = { apiKey: 'kitekey123', accessToken: 'secrettoken456' };

/** Fake Kite API: records requests, answers from a handler. */
function fakeKite(handler: (url: URL) => { status?: number; body: unknown }) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const f = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = handler(url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}
const ok = (data: unknown) => ({ body: { status: 'success', data } });
const kq = (token: number, last: number, prevClose: number, extra: Record<string, unknown> = {}) => ({ instrument_token: token, last_price: last, volume: 1000, last_trade_time: '2026-11-03 15:29:59', ohlc: { open: prevClose + 1, high: last + 5, low: prevClose - 5, close: prevClose }, ...extra });
const yq = (ticker: string, price: number): QuoteSnapshot => ({ ticker, name: `${ticker} Ltd`, price, change: 1, changePct: 0.1, previousClose: price - 1, open: null, dayHigh: null, dayLow: null, volume: null, avgVolume3m: 5, high52: price * 1.2, low52: price * 0.8, marketCap: 1e12, pe: 20, time: null, marketState: null });

describe('read-only Kite client', () => {
  it('maps Yahoo tickers and indices to Kite instruments', () => {
    expect(yahooToKite('INFY.NS')).toBe('NSE:INFY');
    expect(yahooToKite('BAJAJ-AUTO.NS')).toBe('NSE:BAJAJ-AUTO');
    expect(yahooToKite('M&M.NS')).toBe('NSE:M&M');
    expect(yahooToKite('500325.BO')).toBe('BSE:500325');
    expect(yahooToKite('^NSEI')).toBe('NSE:NIFTY 50');
    expect(yahooToKite('^BSESN')).toBe('BSE:SENSEX');
    expect(yahooToKite('^INDIAVIX')).toBe('NSE:INDIA VIX');
    expect(yahooToKite('AAPL')).toBeNull();
  });

  it('reads Kite IST times correctly and formats IST request times', () => {
    expect(kiteTime('2026-11-03 15:29:59')).toBe('2026-11-03T09:59:59.000Z');
    expect(kiteTime('2026-11-03T09:15:00+0530')).toBe('2026-11-03T03:45:00.000Z');
    expect(kiteTime(undefined)).toBeNull();
    expect(istStamp(new Date('2026-11-03T03:45:00Z'))).toBe('2026-11-03 09:15:00');
  });

  it('turns a Kite quote into a quote with change from the previous close, without inventing missing fields', () => {
    const s = kiteToSnapshot('INFY.NS', kq(408065, 1550, 1500));
    expect(s).toMatchObject({ ticker: 'INFY.NS', price: 1550, previousClose: 1500, change: 50, source: 'kite', high52: null, low52: null, marketCap: null, pe: null, name: null });
    expect(s.changePct).toBeCloseTo(3.3333, 3);
  });

  it('sends only GET requests to api.kite.trade with the token header, in batches of 500', async () => {
    const { f, calls } = fakeKite((u) => ok(Object.fromEntries(u.searchParams.getAll('i').map((i, n) => [i, kq(n + 1, 100, 99)]))));
    const kite = new KitePrices(() => CREDS, f, 0);
    const instruments = Array.from({ length: 501 }, (_, i) => `NSE:S${i}`);
    const out = await kite.quote(instruments);
    expect(Object.keys(out)).toHaveLength(501);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('https://api.kite.trade/quote');
    expect(calls[0]!.url.searchParams.getAll('i')).toHaveLength(500);
    expect(calls[0]!.headers).toEqual({ 'X-Kite-Version': '3', Authorization: 'token kitekey123:secrettoken456' });
  });

  it('reports Kite errors with their type and never puts credentials in the message', async () => {
    const { f } = fakeKite(() => ({ status: 403, body: { status: 'error', error_type: 'TokenException', message: 'Incorrect `api_key` or `access_token`.' } }));
    const kite = new KitePrices(() => CREDS, f, 0);
    const err = await kite.quote(['NSE:INFY']).catch((e) => e as KiteError);
    expect(err).toBeInstanceOf(KiteError);
    expect(err).toMatchObject({ type: 'TokenException', status: 403 });
    expect(String(err.message)).not.toContain(CREDS.accessToken);
    expect(kiteProblem(err)).toMatch(/login has expired.*kite-login/);
    const none = new KitePrices(() => null, f, 0);
    await expect(none.quote(['NSE:INFY'])).rejects.toMatchObject({ type: 'ConfigError' });
  });

  it('fetches history in chunks within Kite limits, in IST, using the instrument token from a quote', async () => {
    const { f, calls } = fakeKite((u) =>
      u.pathname === '/quote'
        ? ok({ 'NSE:INFY': kq(408065, 100, 99) })
        : ok({ candles: [[`${u.searchParams.get('from')!.slice(0, 10)}T00:00:00+0530`, 1, 2, 0.5, 1.5, 10]] }),
    );
    const kite = new KitePrices(() => CREDS, f, 0);
    const rows = await kite.historical('NSE:INFY', 'day', new Date('2016-01-01T00:00:00Z'), new Date('2026-11-03T00:00:00Z'));
    const hist = calls.filter((c) => c.url.pathname.startsWith('/instruments/historical/408065/day'));
    expect(hist.length).toBe(2); // about 3,960 days in chunks of at most 2,000
    expect(hist[0]!.url.searchParams.get('from')).toBe('2016-01-01 05:30:00');
    expect(rows[0]!.time.toISOString()).toBe('2015-12-31T18:30:00.000Z'); // midnight IST
  });

  it('builds weekly (Monday-start) and monthly candles from daily candles', () => {
    const d = (iso: string, o: number, h: number, l: number, c: number) => ({ time: new Date(`${iso}T00:00:00+05:30`), open: o, high: h, low: l, close: c, volume: 10 });
    const daily = [d('2026-11-02', 10, 12, 9, 11), d('2026-11-03', 11, 15, 10, 14), d('2026-11-09', 14, 14, 8, 9), d('2026-12-01', 9, 10, 7, 8)];
    const w = aggregateCandles(daily, 'week');
    expect(w.map((x) => [x.open, x.high, x.low, x.close, x.volume])).toEqual([[10, 15, 9, 14, 20], [14, 14, 8, 9, 10], [9, 10, 7, 8, 10]]);
    expect(aggregateCandles(daily, 'month').map((x) => x.close)).toEqual([9, 8]);
  });
});

describe('price service (Kite with a labelled Yahoo fallback)', () => {
  const yahoo = (rows: QuoteSnapshot[]) => ({ quotes: async (t: string[]) => rows.filter((r) => t.includes(r.ticker)), chart: async () => [{ time: new Date('2026-11-03T03:45:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1 }] });

  it('without Kite uses Yahoo and labels it delayed', async () => {
    const p = new PriceService(yahoo([yq('INFY.NS', 1500)]), null);
    const r = await p.quotes(['INFY.NS']);
    expect(r[0]!.source).toBe('yahoo');
    expect(describeQuotes(r)).toMatchObject({ provider: 'yahoo', live: false, label: expect.stringMatching(/delayed by about 15 minutes; not real-time/) });
  });

  it('with Kite: prices from Kite, name and 52-week range from Yahoo; items Kite lacks come from Yahoo and are labelled', async () => {
    const { f } = fakeKite(() => ok({ 'NSE:INFY': kq(1, 1550, 1500), 'NSE:NIFTY 50': kq(2, 24000, 23800) }));
    const p = new PriceService(yahoo([yq('INFY.NS', 1490), yq('^NSEI', 23700), yq('TCS.NS', 3000)]), new KitePrices(() => CREDS, f, 0));
    const r = await p.quotes(['INFY.NS', '^NSEI', 'TCS.NS']);
    expect(r.find((x) => x.ticker === 'INFY.NS')).toMatchObject({ price: 1550, change: 50, source: 'kite', name: 'INFY.NS Ltd', high52: 1490 * 1.2 });
    expect(r.find((x) => x.ticker === '^NSEI')).toMatchObject({ price: 24000, source: 'kite' });
    expect(r.find((x) => x.ticker === 'TCS.NS')).toMatchObject({ price: 3000, source: 'yahoo' });
    expect(describeQuotes(r)).toMatchObject({ provider: 'mixed', label: expect.stringMatching(/Zerodha Kite for 2 of 3 items/) });
    expect(describeQuotes(r.filter((x) => x.source === 'kite'))).toMatchObject({ provider: 'kite', live: true });
  });

  it('when Kite fails it falls back to Yahoo and keeps the reason to show on the page', async () => {
    const { f } = fakeKite(() => ({ status: 403, body: { status: 'error', error_type: 'TokenException', message: 'expired' } }));
    const p = new PriceService(yahoo([yq('INFY.NS', 1490)]), new KitePrices(() => CREDS, f, 0));
    const r = await p.quotes(['INFY.NS']);
    expect(r[0]).toMatchObject({ price: 1490, source: 'yahoo' });
    expect(p.kiteWarning).toMatch(/login has expired/);
    expect(describeQuotes(r, p.kiteWarning).warning).toMatch(/login has expired.*Showing Yahoo Finance \(delayed\) instead/);
  });

  it('charts from Kite, with weekly candles built from daily; falls back to Yahoo with the reason', async () => {
    const { f } = fakeKite((u) => (u.pathname === '/quote' ? ok({ 'NSE:INFY': kq(9, 1, 1) }) : ok({ candles: [['2026-11-02T00:00:00+0530', 1, 3, 0.5, 2, 5], ['2026-11-03T00:00:00+0530', 2, 4, 1, 3, 6]] })));
    const p = new PriceService(yahoo([]), new KitePrices(() => CREDS, f, 0));
    const w = await p.chart('INFY.NS', '1wk', new Date('2026-10-01T00:00:00Z'));
    expect(w).toMatchObject({ provider: 'kite', note: expect.stringMatching(/Weekly candles are built from Kite daily candles/) });
    expect(w.rows).toHaveLength(1);
    const { f: denied } = fakeKite((u) => (u.pathname === '/quote' ? ok({ 'NSE:INFY': kq(9, 1, 1) }) : { status: 403, body: { status: 'error', error_type: 'PermissionException', message: 'Insufficient permission' } }));
    const q = new PriceService(yahoo([]), new KitePrices(() => CREDS, denied, 0));
    expect(await q.chart('INFY.NS', '1d', new Date('2026-10-01T00:00:00Z'))).toMatchObject({ provider: 'yahoo', warning: expect.stringMatching(/historical-data add-on/) });
  });

  it('the API says which source priced the numbers', async () => {
    const { f, dir } = await import('./server.helpers').then((m) => m.engineFiles());
    const s = { userId: 1, username: 'owner', csrfToken: 'x', expiresAt: new Date() };
    const kiteRow = { ...yq('INFY.NS', 1550), source: 'kite' as const };
    const routes = apiRoutes({ files: f, backtestResult: `${dir}/x.json`, tradingConfig: tradingCfg, env: {}, quotes: async () => [kiteRow] });
    const q = (await routes['/api/quote']!(new URLSearchParams({ symbol: 'INFY' }), s)) as { source: { provider: string; live: boolean }; dataNote: string };
    expect(q.source).toMatchObject({ provider: 'kite', live: true });
    expect(q.dataNote).toMatch(/Zerodha Kite/);
    const warn = apiRoutes({ files: f, backtestResult: `${dir}/x.json`, tradingConfig: tradingCfg, env: {}, quotes: async (t) => t.map((x) => ({ ...yq(x, 100), source: 'yahoo' as const })), priceWarning: () => 'Zerodha Kite login has expired' });
    const m = (await warn['/api/market/movers']!(new URLSearchParams(), s)) as { source: { warning: string }; dataNote: string };
    expect(m.source.warning).toMatch(/login has expired\. Showing Yahoo Finance \(delayed\) instead/);
    expect(m.dataNote).toMatch(/delayed by about 15 minutes/);
  });
});

describe('saving the Kite login to .env', () => {
  it('replaces only the token line and keeps everything else, including Windows line endings', () => {
    const text = 'TRADING_MODE=paper\r\nKITE_API_KEY=abc\r\nKITE_ACCESS_TOKEN=old\r\nDATABASE_URL=postgres://x\r\n';
    expect(setEnvValue(text, 'KITE_ACCESS_TOKEN', 'new')).toBe('TRADING_MODE=paper\r\nKITE_API_KEY=abc\r\nKITE_ACCESS_TOKEN=new\r\nDATABASE_URL=postgres://x\r\n');
    expect(setEnvValue('A=1\n', 'KITE_ACCESS_TOKEN', 't')).toBe('A=1\nKITE_ACCESS_TOKEN=t\n');
    expect(setEnvValue('', 'KITE_ACCESS_TOKEN', 't')).toBe('KITE_ACCESS_TOKEN=t\n');
  });
});
