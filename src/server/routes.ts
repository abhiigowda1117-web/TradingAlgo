import { loadWatchlist } from '../study/watchlist';
import type { QuoteSnapshot } from '../research/companyUpdate';
import { LARGE_CAPS, marketMovers, marketOverview, type MarketMovers, type MarketOverview } from '../research/market';
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
  now?: () => Date;
}

const COMPANY_QUERY = /^[A-Za-z0-9&.\- ]{1,60}$/;
const PEER_SYMBOL = /^[A-Z0-9&-]{1,20}$/;

/** Phase 1 API: read-only views of the engine, market, watchlist, trades, backtest and settings. */
export function apiRoutes(d: RouteDeps): ApiRoutes {
  const now = d.now ?? (() => new Date());
  const mode = d.env.TRADING_MODE === 'live' ? 'live' : 'paper';
  const aliveWithinSeconds = Math.max(120, d.tradingConfig.engine.pollSeconds * 4);
  const watchlist = () => loadWatchlist(d.files.watchlist)?.entries.map((e) => e.symbol) ?? [];
  const market = cached<MarketOverview>(60_000, () => marketOverview({ quotes: d.quotes }, { watchlist: watchlist(), holidays: d.tradingConfig.engine.holidays, now: now() }));
  const movers = cached<MarketMovers>(60_000, () => marketMovers({ quotes: d.quotes }, { symbols: LARGE_CAPS, holidays: d.tradingConfig.engine.holidays, now: now() }));
  const paperCapital = Number(d.env.PAPER_CAPITAL ?? 500_000);
  const researchCache = new Map<string, { at: number; report: ResearchReport }>();
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
