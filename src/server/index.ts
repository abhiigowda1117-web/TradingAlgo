import { readFileSync } from 'node:fs';
import { parse as parseEnv } from 'dotenv';
import { resolve } from 'node:path';
import { loadTradingConfig, paths, ROOT } from '../config';
import { LiveUpdateSources, resolveCompany } from '../research/companyUpdate';
import { researchCompany } from '../research/research';
import { LiveResearchSources } from '../research/sources';
import { registerSecret } from '../util/log';
import { createApp } from './app';
import { loadServerConfig } from './config';
import { openDatabase } from './db/open';
import { explainDbError } from './db/pool';
import { ResearchRepo, SessionRepo, SystemLogRepo, UserRepo } from './db/repositories';
import { apiActions, apiRoutes, cached, type RouteDeps } from './routes';
import { AutoStudy } from './services/autoStudy';
import { ControlService } from './services/control';
import { loadWatchlist } from '../study/watchlist';
import { istParts } from '../util/time';
import { KitePrices, type KiteCredentials } from './services/kitePrices';
import { PriceService } from './services/prices';

// Usage: npm run server   (API on http://localhost:3001; also serves web/dist when built)
// Read-only towards trading: it shows engine status but never places orders.
const cfg = loadServerConfig();
for (const s of [process.env.KITE_API_KEY, process.env.KITE_API_SECRET, process.env.KITE_ACCESS_TOKEN, process.env.DATABASE_URL]) registerSecret(s);
const tradingMode = process.env.TRADING_MODE === 'live' ? 'live' : 'paper';
const version = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const database = openDatabase({ databaseUrl: cfg.databaseUrl });
const pool = database.db;
try {
  const applied = await database.migrate();
  if (applied.length) console.log(`Database migrations applied: ${applied.join(', ')}`);
  console.log(`Database: ${database.describe}`);
} catch (e) {
  console.error(`Could not open or migrate the database (${database.describe}):\n  ${explainDbError(e)}${database.kind === 'postgres' ? '\nCheck DATABASE_URL in .env and that PostgreSQL is running, or remove DATABASE_URL to use the built-in database.' : ''}`);
  process.exit(1);
}
const users = new UserRepo(pool);
const sessions = new SessionRepo(pool, cfg.sessionTtlMs);
if ((await users.count()) === 0) console.warn(`No account yet. Open http://localhost:${cfg.port} on this computer to create yours.`);
setInterval(() => sessions.purgeExpired().catch(() => undefined), 3_600_000).unref();

const sources = new LiveUpdateSources();
const researchSources = new LiveResearchSources();

// Website prices: Yahoo Finance (free, delayed) by default; Zerodha Kite when WEB_MARKET_DATA=kite.
// Kite access tokens expire daily, so the login is re-read from .env (at most every 30 s): after
// "npm run kite-login" the new token is used without restarting the server.
const webMarketData = process.env.WEB_MARKET_DATA === 'kite' ? 'kite' : 'yahoo';
let kiteCredsCache: { at: number; value: KiteCredentials | null } = { at: 0, value: null };
const kiteCreds = (): KiteCredentials | null => {
  if (Date.now() - kiteCredsCache.at < 30_000) return kiteCredsCache.value;
  let file: Record<string, string> = {};
  try {
    file = parseEnv(readFileSync(resolve(ROOT, '.env')));
  } catch {
    // No .env file: use the process environment only.
  }
  const apiKey = file.KITE_API_KEY || process.env.KITE_API_KEY || '';
  const accessToken = file.KITE_ACCESS_TOKEN || process.env.KITE_ACCESS_TOKEN || '';
  registerSecret(apiKey);
  registerSecret(accessToken);
  kiteCredsCache = { at: Date.now(), value: apiKey && accessToken ? { apiKey, accessToken } : null };
  return kiteCredsCache.value;
};
const prices = new PriceService({ quotes: (t) => sources.quotes(t), chart: (t, iv, from) => sources.chart(t, iv, from) }, webMarketData === 'kite' ? new KitePrices(kiteCreds) : null);
if (webMarketData === 'kite') {
  console.log(kiteCreds() ? 'Website prices: Zerodha Kite (WEB_MARKET_DATA=kite).' : 'WEB_MARKET_DATA=kite, but KITE_API_KEY / KITE_ACCESS_TOKEN are missing from .env. The site shows Yahoo Finance and says why.');
}

const quoteCaches = new Map<string, () => ReturnType<LiveUpdateSources['quotes']>>();
const quotes = (tickers: string[]) => {
  const key = [...tickers].sort().join(',');
  let c = quoteCaches.get(key);
  if (!c) {
    if (quoteCaches.size > 500) quoteCaches.clear(); // bound memory: one entry per distinct ticker set
    // 20 s: fresh enough for the 30-second live price on the research page; views add their own caching.
    quoteCaches.set(key, (c = cached(20_000, () => prices.quotes(tickers))));
  }
  return c();
};

const control = new ControlService({ root: ROOT, engineLock: paths.engineLock, engineStopRequest: paths.engineStopRequest, jobsLog: paths.jobsLog }, { tradingMode });
const tradingConfig = loadTradingConfig();
// Daily automatic analysis (AUTO_STUDY=false turns it off): fresh watchlist every trading day from 08:45 IST.
const autoStudy = /^(0|false|no|off)$/i.test(process.env.AUTO_STUDY ?? '')
  ? undefined
  : new AutoStudy({
      now: () => new Date(),
      watchlistDate: () => {
        const wl = loadWatchlist(paths.watchlist);
        return wl?.generatedAt ? istParts(new Date(wl.generatedAt)).date : null;
      },
      jobRunning: () => control.jobStatus()?.state === 'running',
      run: () => control.runJob('study', 'automatic'),
      holidays: tradingConfig.engine.holidays ?? [],
    });
if (autoStudy) {
  setTimeout(() => autoStudy.tick(), 30_000).unref();
  setInterval(() => autoStudy.tick(), 60_000).unref();
}

const routeDeps: RouteDeps = {
  files: paths,
  backtestResult: paths.backtestResult,
  tradingConfig,
  env: process.env,
  quotes,
  researchRepo: new ResearchRepo(pool),
  chart: (ticker, interval, from) => prices.chart(ticker, interval, from),
  priceWarning: () => prices.kiteWarning,
  research: async (query, peers) => {
    // Accept a company name or symbol; research needs an NSE listing.
    const { ticker, symbol } = await resolveCompany(query, sources);
    if (!ticker.endsWith('.NS')) throw new Error(`${query} resolves to a BSE-only listing (${ticker}); research covers NSE-listed companies. Check the NSE symbol.`);
    return researchCompany(symbol, researchSources, { peers });
  },
  // Website controls: start/stop the PAPER engine as a separate program, run jobs, queue paper orders.
  control,
  autoStudy: autoStudy ? () => autoStudy.status() : undefined,
  manualOrdersDir: paths.manualOrders,
  activeStrategyFile: paths.activeStrategy,
  strategyLabFile: paths.strategyLab,
  activeProfileFile: paths.activeProfile,
};

const app = createApp({
  db: pool,
  users,
  sessions,
  logs: new SystemLogRepo(pool),
  allowedOrigins: cfg.allowedOrigins,
  cookieSecure: cfg.cookieSecure,
  trustProxy: cfg.trustProxy,
  sessionTtlMs: cfg.sessionTtlMs,
  tradingMode,
  version,
  staticDir: cfg.staticDir,
  setupCode: cfg.setupCode,
  routes: apiRoutes(routeDeps),
  actions: apiActions(routeDeps),
});
app.listen(cfg.port, cfg.host, () => {
  console.log(`AlgoTrade server on http://${cfg.host === '127.0.0.1' ? 'localhost' : cfg.host}:${cfg.port}  (trading mode: ${tradingMode}; website controls run the paper engine, the server itself never sends orders)`);
});
