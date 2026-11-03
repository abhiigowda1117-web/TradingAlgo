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
import { migrate, poolTarget } from './db/migrate';
import { createPool } from './db/pool';
import { ResearchRepo, SessionRepo, SystemLogRepo, UserRepo } from './db/repositories';
import { apiRoutes, cached } from './routes';
import { KitePrices, type KiteCredentials } from './services/kitePrices';
import { PriceService } from './services/prices';

// Usage: npm run server   (API on http://localhost:3001; also serves web/dist when built)
// Read-only towards trading: it shows engine status but never places orders.
const cfg = loadServerConfig();
for (const s of [process.env.KITE_API_KEY, process.env.KITE_API_SECRET, process.env.KITE_ACCESS_TOKEN, process.env.DATABASE_URL]) registerSecret(s);
const tradingMode = process.env.TRADING_MODE === 'live' ? 'live' : 'paper';
const version = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const pool = createPool(cfg.databaseUrl);
try {
  const applied = await migrate(poolTarget(pool), resolve(ROOT, 'db/migrations'));
  if (applied.length) console.log(`Database migrations applied: ${applied.join(', ')}`);
} catch (e) {
  console.error(`Could not connect to or migrate the database: ${(e as Error).message}\nCheck DATABASE_URL in .env and that PostgreSQL is running.`);
  process.exit(1);
}
const users = new UserRepo(pool);
const sessions = new SessionRepo(pool, cfg.sessionTtlMs);
if ((await users.count()) === 0) console.warn('No owner account yet. Create one:  npm run user:create -- --username yourname');
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
  routes: apiRoutes({
    files: paths,
    backtestResult: paths.backtestResult,
    tradingConfig: loadTradingConfig(),
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
  }),
});
app.listen(cfg.port, cfg.host, () => {
  console.log(`AlgoTrade server on http://${cfg.host === '127.0.0.1' ? 'localhost' : cfg.host}:${cfg.port}  (trading mode shown: ${tradingMode}; this server never places orders)`);
});
