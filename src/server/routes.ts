import { loadWatchlist } from '../study/watchlist';
import type { QuoteSnapshot } from '../research/companyUpdate';
import { marketOverview, type MarketOverview } from '../research/market';
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
  now?: () => Date;
}

/** Phase 1 API: read-only views of the engine, market, watchlist, trades, backtest and settings. */
export function apiRoutes(d: RouteDeps): ApiRoutes {
  const now = d.now ?? (() => new Date());
  const mode = d.env.TRADING_MODE === 'live' ? 'live' : 'paper';
  const aliveWithinSeconds = Math.max(120, d.tradingConfig.engine.pollSeconds * 4);
  const watchlist = () => loadWatchlist(d.files.watchlist)?.entries.map((e) => e.symbol) ?? [];
  const market = cached<MarketOverview>(60_000, () => marketOverview({ quotes: d.quotes }, { watchlist: watchlist(), holidays: d.tradingConfig.engine.holidays, now: now() }));
  const status = () => engineStatus(d.files, { now: now(), aliveWithinSeconds, mode, quotes: d.quotes });

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
  };
}
