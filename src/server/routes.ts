import { loadWatchlist } from '../study/watchlist';
import type { ChartYahooInterval, QuoteSnapshot } from '../research/companyUpdate';
import type { Candle } from '../research/types';
import { describeQuotes, type PriceSourceInfo } from './services/prices';
import { LARGE_CAPS, marketMovers, marketOverview, sessionStatus, type MarketMovers, type MarketOverview } from '../research/market';
import type { ResearchReport } from '../research/research';
import type { ResearchRepo } from './db/repositories';
import type { TradingConfig } from '../config';
import type { ApiRoutes } from './app';
import { HttpError } from './app';
import { dashboardTrades, engineStatus, latestBacktest, settingsView } from './services/dashboard';
import type { EngineFiles } from './services/engineView';

/** Small TTL cache that also merges concurrent loads (protects Yahoo from bursts). */
export function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let value: { at: number; v: T } | undefined;
  let inflight: Promise<T> | undefined;
  return async () => {
    if (value && Date.now() - value.at < ttlMs) return value.v;
    inflight ??= load().finally(() => (inflight = undefined));
    const v = await inflight;
    value = { at: Date.now(), v };
    return v;
  };
}

export interface RouteDeps {
  files: EngineFiles;
  backtestResult: string;
  tradingConfig: TradingConfig;
  env: NodeJS.ProcessEnv;
  quotes: (tickers: string[]) => Promise<QuoteSnapshot[]>;
  /** Runs company research for a name or NSE symbol (read-only; never touches trading). */
  research?: (query: string, peers: string[]) => Promise<ResearchReport>;
  researchRepo?: ResearchRepo;
  /** Candles for the interactive chart (read-only market data). A plain array means Yahoo Finance. */
  chart?: (ticker: string, interval: ChartYahooInterval, from: Date) => Promise<Candle[] | { rows: Candle[]; provider: 'kite' | 'yahoo'; warning?: string; note?: string }>;
  /** Current Zerodha Kite problem, if Kite is switched on but failing (shown on the page). */
  priceWarning?: () => string | undefined;
  now?: () => Date;
}

const COMPANY_QUERY = /^[A-Za-z0-9&.\- ]{1,60}$/;
const PEER_SYMBOL = /^[A-Z0-9&-]{1,20}$/;

/**
 * Chart intervals and the ranges each allows. Yahoo limits intraday history: 1-minute candles for about
 * 7 days, 5/15/30-minute for 60 days, hourly for 2 years.
 */
const CHART_INTERVALS: Record<string, { yahoo: ChartYahooInterval; intraday: boolean; ranges: string[] }> = {
  '1m': { yahoo: '1m', intraday: true, ranges: ['1D', '5D'] },
  '5m': { yahoo: '5m', intraday: true, ranges: ['1D', '5D', '1M'] },
  '15m': { yahoo: '15m', intraday: true, ranges: ['1D', '5D', '1M'] },
  '30m': { yahoo: '30m', intraday: true, ranges: ['5D', '1M'] },
  '1h': { yahoo: '60m', intraday: true, ranges: ['1M', '3M', '6M', '1Y'] },
  '1d': { yahoo: '1d', intraday: false, ranges: ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'MAX'] },
  '1w': { yahoo: '1wk', intraday: false, ranges: ['1Y', '3Y', '5Y', 'MAX'] },
  '1mo': { yahoo: '1mo', intraday: false, ranges: ['5Y', 'MAX'] },
};
const RANGE_DAYS: Record<string, number> = { '1D': 6, '5D': 7, '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '3Y': 1096, '5Y': 1827, MAX: 10958 };
const IST_SECONDS = 19_800;

export interface ChartCandle {
  /** Intraday: Unix seconds shifted to IST (so the chart's axis reads IST). Daily and longer: YYYY-MM-DD. */
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Converts provider candles to chart candles: IST times, ascending, one candle per time; '1D' keeps the latest session. */
export function toChartCandles(rows: Candle[], intraday: boolean, range: string): ChartCandle[] {
  const byTime = new Map<number | string, ChartCandle>();
  for (const r of rows) {
    const time = intraday ? Math.floor(r.time.getTime() / 1000) + IST_SECONDS : new Date(r.time.getTime() + IST_SECONDS * 1000).toISOString().slice(0, 10);
    byTime.set(time, { time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }); // later rows win
  }
  let out = [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  if (range === '1D' && intraday && out.length) {
    const lastDay = Math.floor((out.at(-1)!.time as number) / 86_400);
    out = out.filter((c) => Math.floor((c.time as number) / 86_400) === lastDay);
  }
  return out;
}

/** Phase 1 API: read-only views of the engine, market, watchlist, trades, backtest and settings. */
export function apiRoutes(d: RouteDeps): ApiRoutes {
  const now = d.now ?? (() => new Date());
  const mode = d.env.TRADING_MODE === 'live' ? 'live' : 'paper';
  const aliveWithinSeconds = Math.max(120, d.tradingConfig.engine.pollSeconds * 4);
  const watchlist = () => loadWatchlist(d.files.watchlist)?.entries.map((e) => e.symbol) ?? [];
  // Each view records which provider priced its rows, so the page can say where the numbers came from.
  const sourced = async <T>(build: (quotes: RouteDeps['quotes']) => Promise<T>) => {
    const seen: QuoteSnapshot[] = [];
    const out = await build(async (t) => {
      const r = await d.quotes(t);
      seen.push(...r);
      return r;
    });
    return { out, source: describeQuotes(seen, d.priceWarning?.()) };
  };
  const market = cached<MarketOverview & { source: PriceSourceInfo }>(60_000, async () => {
    const { out, source } = await sourced((quotes) => marketOverview({ quotes }, { watchlist: watchlist(), holidays: d.tradingConfig.engine.holidays, now: now() }));
    return { ...out, source, dataNote: `${source.label} Items with no price show Not Available.` };
  });
  const movers = cached<MarketMovers & { source: PriceSourceInfo }>(60_000, async () => {
    const { out, source } = await sourced((quotes) => marketMovers({ quotes }, { symbols: LARGE_CAPS, holidays: d.tradingConfig.engine.holidays, now: now() }));
    return { ...out, source, dataNote: `Scans ${out.scanned} large NSE companies (close to the NIFTY 50 list). ${source.label}` };
  });
  const paperCapital = Number(d.env.PAPER_CAPITAL ?? 500_000);
  const researchCache = new Map<string, { at: number; report: ResearchReport }>();
  const chartCache = new Map<string, { at: number; p: Promise<{ candles: ChartCandle[]; provider: 'kite' | 'yahoo'; warning?: string; note?: string }> }>();
  const researchInflight = new Map<string, Promise<ResearchReport>>();
  const status = () => engineStatus(d.files, { now: now(), aliveWithinSeconds, mode, quotes: d.quotes, initialCash: Number.isFinite(paperCapital) && paperCapital > 0 ? paperCapital : undefined });

  return {
    '/api/engine/status': status,
    '/api/dashboard/summary': async () => {
      const engine = await status();
      return { engine, trades: dashboardTrades(d.files, 8), backtest: latestBacktest(d.backtestResult), watchlistCount: watchlist().length };
    },
    '/api/market/overview': async () => {
      try {
        return await market();
      } catch (e) {
        // A data-provider outage is not a server bug: say which source failed (502), not "internal error".
        throw new HttpError(502, `Market data unavailable from Yahoo Finance (${(e as Error).message}). Try again in a few minutes.`);
      }
    },
    '/api/market/movers': async () => {
      try {
        return await movers();
      } catch (e) {
        throw new HttpError(502, `Market data unavailable from Yahoo Finance (${(e as Error).message}). Try again in a few minutes.`);
      }
    },
    '/api/quote': async (q) => {
      const symbol = (q.get('symbol') ?? '').trim().toUpperCase();
      if (!PEER_SYMBOL.test(symbol)) throw new HttpError(400, 'symbol must be an NSE symbol, e.g. RELIANCE');
      let rows: QuoteSnapshot[];
      try {
        rows = await d.quotes([`${symbol}.NS`]);
      } catch (e) {
        throw new HttpError(502, `Price unavailable from Yahoo Finance (${(e as Error).message}). Trying again shortly.`);
      }
      const row = rows.find((r) => r.ticker === `${symbol}.NS`);
      if (!row || row.price === null) throw new HttpError(404, `No price available for ${symbol} right now`);
      const source = describeQuotes([row], d.priceWarning?.());
      return { symbol, ...row, session: sessionStatus(now(), d.tradingConfig.engine.holidays), fetchedAt: now().toISOString(), source, dataNote: source.label };
    },
    '/api/chart': async (q) => {
      if (!d.chart) throw new HttpError(503, 'Charts are not configured on this server');
      const symbol = (q.get('symbol') ?? '').trim().toUpperCase();
      if (!PEER_SYMBOL.test(symbol)) throw new HttpError(400, 'symbol must be an NSE symbol, e.g. RELIANCE');
      const interval = q.get('interval') ?? '1d';
      const spec = CHART_INTERVALS[interval];
      if (!spec) throw new HttpError(400, `interval must be one of ${Object.keys(CHART_INTERVALS).join(', ')}`);
      const range = (q.get('range') ?? spec.ranges[Math.min(1, spec.ranges.length - 1)]!).toUpperCase();
      if (!spec.ranges.includes(range)) throw new HttpError(400, `Range ${range} is not available for ${interval} candles; choose ${spec.ranges.join(', ')}`);
      const key = `${symbol}|${interval}|${range}`;
      const ttl = spec.intraday ? 30_000 : 600_000;
      let hit = chartCache.get(key);
      if (!hit || Date.now() - hit.at > ttl) {
        const from = new Date(now().getTime() - RANGE_DAYS[range]! * 86_400_000);
        hit = {
          at: Date.now(),
          p: d.chart(`${symbol}.NS`, spec.yahoo, from).then((res) => {
            const r = Array.isArray(res) ? { rows: res, provider: 'yahoo' as const } : res;
            return { candles: toChartCandles(r.rows, spec.intraday, range), provider: r.provider, warning: 'warning' in r ? r.warning : undefined, note: 'note' in r ? r.note : undefined };
          }),
        };
        chartCache.set(key, hit);
        if (chartCache.size > 300) chartCache.delete(chartCache.keys().next().value!);
      }
      let result: Awaited<typeof hit.p>;
      try {
        result = await hit.p;
      } catch (e) {
        chartCache.delete(key); // do not cache failures
        throw new HttpError(502, `Chart data unavailable from Yahoo Finance (${(e as Error).message}). Try again shortly.`);
      }
      const { candles, provider, warning, note } = result;
      if (!candles.length) throw new HttpError(404, `No ${interval} price data for ${symbol} in this range`);
      return {
        symbol, interval, range, intraday: spec.intraday, ranges: spec.ranges, candles,
        session: sessionStatus(now(), d.tradingConfig.engine.holidays), fetchedAt: now().toISOString(),
        source: provider === 'kite'
          ? { provider, live: true, label: 'Zerodha Kite: exchange candles as provided by Kite.' }
          : { provider, live: false, label: 'Yahoo Finance, delayed by about 15 minutes; not real-time.', ...(warning ? { warning: `${warning}. Showing Yahoo Finance (delayed) instead.` } : {}) },
        dataNote: provider === 'kite'
          ? `Candles from Zerodha Kite, as provided by Kite. Times are IST.${note ? ` ${note}` : ''}`
          : 'Candles from Yahoo Finance, delayed by about 15 minutes; not real-time. Times are IST.',
      };
    },
    '/api/watchlist': () => {
      const wl = loadWatchlist(d.files.watchlist);
      return wl ?? { generatedAt: null, entries: [], rejected: [] };
    },
    '/api/trades': (q) => {
      const n = Number(q.get('limit') ?? 50);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new HttpError(400, 'limit must be 1 to 500');
      return dashboardTrades(d.files, n);
    },
    '/api/backtest/latest': () => latestBacktest(d.backtestResult) ?? { none: true, hint: 'Run: npm run portfolio -- --json data/backtests/latest.json' },
    '/api/settings': () => settingsView(d.tradingConfig, d.env),
    '/api/research': async (q, session) => {
      if (!d.research) throw new HttpError(503, 'Research is not configured on this server');
      const query = (q.get('q') ?? '').trim();
      const peers = (q.get('peers') ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      if (!COMPANY_QUERY.test(query)) throw new HttpError(400, 'Enter a company name or NSE symbol (letters, digits, spaces, & . -)');
      if (peers.length > 6 || peers.some((p) => !PEER_SYMBOL.test(p))) throw new HttpError(400, 'Peers must be up to 6 NSE symbols, comma separated');
      const key = `${query.toUpperCase()}|${peers.join(',')}`;
      const hit = researchCache.get(key);
      if (q.get('refresh') !== '1' && hit && Date.now() - hit.at < 15 * 60_000) return { ...hit.report, cached: true };
      let p = researchInflight.get(key);
      if (!p) {
        p = d.research(query, peers).finally(() => researchInflight.delete(key));
        researchInflight.set(key, p);
      }
      let report: ResearchReport;
      try {
        report = await p;
      } catch (e) {
        const msg = (e as Error).message;
        // "Not found" style problems are the user's input; everything else is a data-source outage.
        throw new HttpError(/no (data|nse|price)|not a valid|not found|check the/i.test(msg) ? 404 : 502, msg);
      }
      researchCache.set(key, { at: Date.now(), report });
      if (researchCache.size > 100) researchCache.delete(researchCache.keys().next().value!);
      await d.researchRepo?.save(session.userId, report.symbol, report.generatedAt, report).catch(() => undefined);
      return report;
    },
    '/api/research/recent': async (_q, session) => (d.researchRepo ? d.researchRepo.recent(session.userId) : []),
  };
}
