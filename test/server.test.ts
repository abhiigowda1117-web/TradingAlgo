import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuoteSnapshot } from '../src/research/companyUpdate';
import { COOKIE, createApp, type AppDeps } from '../src/server/app';
import { hashPassword, verifyPassword } from '../src/server/auth/password';
import { RateLimiter } from '../src/server/auth/rateLimit';
import { loadServerConfig } from '../src/server/config';
import { migrate } from '../src/server/db/migrate';
import { SessionRepo, SystemLogRepo, UserRepo } from '../src/server/db/repositories';
import { apiRoutes } from '../src/server/routes';
import { tradingCfg } from './helpers';

const PASSWORD = 'correct horse battery';
const ORIGIN = 'http://localhost:5173';

/** In-memory PostgreSQL with the real migrations applied (pg-mem lacks the ~ regex operator, so add it). */
async function memoryDb() {
  const mem = newDb();
  mem.public.registerOperator({ operator: '~', left: DataType.text, right: DataType.text, returns: DataType.bool, implementation: (a: string, b: string) => new RegExp(b).test(a) });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool, 'db/migrations');
  return pool;
}

/** Engine files in a temp dir, as the paper engine would leave them. */
function engineFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'web-'));
  const f = {
    state: join(dir, 'state.json'),
    paperAccount: join(dir, 'paper.json'),
    trades: join(dir, 'trades.jsonl'),
    engineLog: join(dir, 'engine.log'),
    heartbeat: join(dir, 'heartbeat.json'),
    killSwitch: join(dir, 'STOP'),
    watchlist: join(dir, 'watchlist.json'),
  };
  writeFileSync(f.state, JSON.stringify({ positions: { INFY: { symbol: 'INFY', qty: 10, entryPrice: 1500, entryDate: '2026-11-02', initialStop: 1450, stop: 1460, highestClose: 1510, protection: 'confirmed', protectedStop: 1460 } }, intents: {}, seq: 1, dayStartEquity: 500_000, lastEvaluated: '2026-11-02' }));
  writeFileSync(f.paperAccount, JSON.stringify({ cash: 485_000, positions: { INFY: 10 }, orders: {}, nextId: 3 }));
  writeFileSync(f.heartbeat, JSON.stringify({ at: new Date().toISOString(), result: 'ok', broker: 'paper' }));
  writeFileSync(f.trades, JSON.stringify({ time: '2026-11-02T09:45:00Z', symbol: 'INFY', side: 'BUY', qty: 10, price: 1500, reason: 'EMA crossover' }) + '\n');
  writeFileSync(f.watchlist, JSON.stringify({ generatedAt: new Date().toISOString(), entries: [{ symbol: 'INFY', name: 'Infosys', combinedScore: 70, fundamentalScore: 72, sentiment: 0.1 }], rejected: [] }));
  return { dir, f };
}

const quote = (ticker: string, price: number): QuoteSnapshot => ({ ticker, name: ticker, price, change: 1, changePct: 0.5, previousClose: price - 1, open: null, dayHigh: null, dayLow: null, volume: null, avgVolume3m: null, high52: null, low52: null, marketCap: null, pe: null, time: null, marketState: null });

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start(over: Partial<AppDeps> = {}, env: NodeJS.ProcessEnv = {}) {
  const pool = await memoryDb();
  const users = new UserRepo(pool);
  await users.upsertOwner('owner', await hashPassword(PASSWORD));
  const { dir, f } = engineFixture();
  const sessions = new SessionRepo(pool, 3_600_000);
  const app = createApp({
    db: pool,
    users,
    sessions,
    logs: new SystemLogRepo(pool),
    allowedOrigins: [ORIGIN],
    cookieSecure: false,
    trustProxy: false,
    sessionTtlMs: 3_600_000,
    tradingMode: 'paper',
    version: 'test',
    routes: apiRoutes({ files: f, backtestResult: join(dir, 'none.json'), tradingConfig: tradingCfg, env, quotes: async (t) => t.map((x) => quote(x, 1550)) }),
    ...over,
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  close = () => app.close();
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  return { base, pool, sessions, f };
}

const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });

async function signIn(base: string) {
  const res = await fetch(`${base}/api/auth/login`, json({ username: 'owner', password: PASSWORD }));
  const cookie = res.headers.get('set-cookie')!;
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { res, cookie: cookie.split(';')[0]!, setCookie: cookie, csrfToken };
}

const PROTECTED = ['/api/auth/me', '/api/dashboard/summary', '/api/engine/status', '/api/market/overview', '/api/watchlist', '/api/trades', '/api/backtest/latest', '/api/settings'];

describe('passwords', () => {
  it('hashes with scrypt, verifies, and rejects short passwords', async () => {
    const h = await hashPassword(PASSWORD);
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, h)).toBe(true);
    expect(await verifyPassword('wrong password!', h)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow(/at least 10/);
  });
});

describe('database', () => {
  it('migrations are idempotent and create every table', async () => {
    const pool = await memoryDb();
    expect(await migrate(pool, 'db/migrations')).toEqual([]);
    for (const t of ['users', 'sessions', 'portfolios', 'positions', 'orders', 'trades', 'research_reports', 'system_logs']) {
      await expect(pool.query(`SELECT count(*) FROM ${t}`)).resolves.toBeTruthy();
    }
  });

  it('stores only a hash of the session id, and expires sessions', async () => {
    const pool = await memoryDb();
    const users = new UserRepo(pool);
    await users.upsertOwner('owner', 'scrypt$x');
    const u = (await users.findByUsername('OWNER'))!;
    let now = new Date('2026-11-03T10:00:00Z');
    const repo = new SessionRepo(pool, 60_000, () => now);
    const s = await repo.create(u.id);
    const rows = (await pool.query('SELECT id_hash FROM sessions')).rows;
    expect(rows[0].id_hash).not.toBe(s.id);
    expect((await repo.get(s.id))?.username).toBe('owner');
    now = new Date('2026-11-03T10:02:00Z');
    expect(await repo.get(s.id)).toBeUndefined();
  });
});

describe('server configuration', () => {
  it('requires a database URL and HTTPS cookies in production', () => {
    expect(() => loadServerConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadServerConfig({ DATABASE_URL: 'postgres://u:p@localhost/db', NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    const c = loadServerConfig({ DATABASE_URL: 'postgres://u:p@localhost/db' });
    expect(c).toMatchObject({ port: 3001, host: '127.0.0.1', cookieSecure: false });
    expect(c.allowedOrigins).toContain('http://localhost:5173');
  });
});

describe('API authentication', () => {
  it('health is public and reports the database state', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', database: 'ok', tradingMode: 'paper' });
  });

  it('rejects every private route without a session', async () => {
    const { base } = await start();
    for (const p of PROTECTED) expect((await fetch(`${base}${p}`)).status, p).toBe(401);
    expect((await fetch(`${base}/api/dashboard/summary`, { headers: { Cookie: `${COOKIE}=forged` } })).status).toBe(401);
  });

  it('signs in with a secure cookie and then allows private routes', async () => {
    const { base, pool } = await start();
    const { res, setCookie, cookie, csrfToken } = await signIn(base);
    expect(res.status).toBe(200);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    expect(csrfToken.length).toBeGreaterThan(20);
    for (const p of PROTECTED) expect((await fetch(`${base}${p}`, { headers: { Cookie: cookie } })).status, p).toBe(200);
    const logs = (await pool.query(`SELECT message FROM system_logs`)).rows.map((r: { message: string }) => r.message);
    expect(logs).toContain('Signed in');
  });

  it('rejects wrong credentials and locks out after repeated failures', async () => {
    const { base } = await start({ loginLimit: { max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect((await fetch(`${base}/api/auth/login`, json({ username: 'owner', password: 'wrong password!' }))).status).toBe(401);
    expect((await fetch(`${base}/api/auth/login`, json({ username: 'nobody', password: PASSWORD }))).status).toBe(429);
    expect((await fetch(`${base}/api/auth/login`, json({ username: 'owner', password: PASSWORD }))).status).toBe(429);
  });

  it('accepts only JSON login bodies (blocks cross-site form posts)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=owner&password=${encodeURIComponent(PASSWORD)}` });
    expect(res.status).toBe(415);
  });

  it('requires the CSRF token to sign out, then ends the session', async () => {
    const { base } = await start();
    const { cookie, csrfToken } = await signIn(base);
    expect((await fetch(`${base}/api/auth/logout`, json({}, { Cookie: cookie }))).status).toBe(403);
    expect((await fetch(`${base}/api/auth/logout`, json({}, { Cookie: cookie, 'X-CSRF-Token': csrfToken }))).status).toBe(200);
    expect((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('requires CSRF for any non-GET private request', async () => {
    const { base } = await start();
    const { cookie } = await signIn(base);
    expect((await fetch(`${base}/api/settings`, json({}, { Cookie: cookie }))).status).toBe(403);
  });
});

describe('API protection', () => {
  it('allows only the app origin (CORS)', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const ok = await fetch(`${base}/api/health`, { headers: { Origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const pre = await fetch(`${base}/api/auth/login`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
  });

  it('rate-limits API traffic per address', async () => {
    const { base } = await start({ apiLimit: { max: 3, windowMs: 60_000 } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/health`)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('sends security headers', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('never returns broker secrets', async () => {
    const env = { TRADING_MODE: 'paper', KITE_API_KEY: 'kitekey123456', KITE_API_SECRET: 'kitesecret987654', KITE_ACCESS_TOKEN: 'accesstoken555', DATABASE_URL: 'postgres://u:dbpassword42@h/db' };
    const { base } = await start({}, env);
    const { cookie } = await signIn(base);
    for (const p of PROTECTED) {
      const body = await (await fetch(`${base}${p}`, { headers: { Cookie: cookie } })).text();
      for (const secret of ['kitekey123456', 'kitesecret987654', 'accesstoken555', 'dbpassword42']) expect(body, p).not.toContain(secret);
    }
    const settings = await (await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } })).json();
    expect(settings.brokerConfigured).toBe(true);
  });
});

describe('dashboard data', () => {
  it('values the paper portfolio from engine files and delayed quotes', async () => {
    const { base } = await start();
    const { cookie } = await signIn(base);
    const s = await (await fetch(`${base}/api/dashboard/summary`, { headers: { Cookie: cookie } })).json();
    expect(s.engine.cash).toBe(485_000);
    expect(s.engine.positions[0]).toMatchObject({ symbol: 'INFY', last: 1550, pnl: 500, protection: 'confirmed' });
    expect(s.engine.equity).toBe(485_000 + 15_500);
    expect(s.engine.dayPnl).toBe(500);
    expect(s.engine.heartbeat.alive).toBe(true);
    expect(s.engine.killSwitch).toBe('off');
    expect(s.trades[0]).toMatchObject({ symbol: 'INFY', side: 'BUY' });
    expect(s.backtest).toBeNull();
  });

  it('shows Not Available equity instead of guessing when prices fail', async () => {
    const pool = await memoryDb();
    const { f, dir } = engineFixture();
    const routes = apiRoutes({ files: f, backtestResult: join(dir, 'x.json'), tradingConfig: tradingCfg, env: {}, quotes: async () => { throw new Error('Yahoo 429'); } });
    const s = (await routes['/api/engine/status']!(new URLSearchParams(), { userId: 1, username: 'owner', csrfToken: 'x', expiresAt: new Date() })) as { equity: unknown; priceError: string };
    expect(s.equity).toBeNull();
    expect(s.priceError).toMatch(/Yahoo 429/);
    await pool.end?.();
  });

  it('validates query parameters', async () => {
    const { base } = await start();
    const { cookie } = await signIn(base);
    expect((await fetch(`${base}/api/trades?limit=99999`, { headers: { Cookie: cookie } })).status).toBe(400);
  });
});

describe('static site', () => {
  it('serves the built app, falls back to index.html for app routes, and blocks path traversal', async () => {
    const site = mkdtempSync(join(tmpdir(), 'site-'));
    mkdirSync(join(site, 'assets'));
    writeFileSync(join(site, 'index.html'), '<html>AlgoTrade app</html>');
    writeFileSync(join(site, 'assets', 'app.js'), 'console.log(1)');
    const { base } = await start({ staticDir: site });
    expect(await (await fetch(`${base}/`)).text()).toContain('AlgoTrade app');
    expect(await (await fetch(`${base}/portfolio`)).text()).toContain('AlgoTrade app');
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toMatch(/immutable/);
    const sneaky = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect(await sneaky.text()).not.toContain('"dependencies"');
  });

  it('explains how to build the frontend when it is missing', async () => {
    const { base } = await start({ staticDir: join(tmpdir(), 'does-not-exist') });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/npm run web:build/);
  });
});

describe('rate limiter', () => {
  it('counts within a sliding window', () => {
    let t = 0;
    const r = new RateLimiter(2, 1000, () => t);
    expect([r.take('a'), r.take('a'), r.take('a')]).toEqual([true, true, false]);
    t = 1500;
    expect(r.take('a')).toBe(true);
  });
});

describe('separation from trading', () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((x) => (statSync(join(d, x)).isDirectory() ? files(join(d, x)) : [join(d, x)]));
  it('the web server never imports broker, engine or factory code at runtime', () => {
    for (const f of files('src/server')) {
      const runtimeImports = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => /\b(import|require)\b/.test(l) && !/^\s*import type\b/.test(l));
      expect(runtimeImports.join('\n'), f).not.toMatch(/['"][^'"]*(brokers|trading\/engine|factory|kiteClient|paperBroker)[^'"]*['"]/);
    }
  });
});

describe('data source outages', () => {
  it('reports a market-data outage as 502 with the source named, not an internal error', async () => {
    const pool = await memoryDb();
    const users = new UserRepo(pool);
    await users.upsertOwner('owner', await hashPassword(PASSWORD));
    const { f, dir } = engineFixture();
    const app = createApp({
      db: pool, users, sessions: new SessionRepo(pool, 3_600_000), logs: new SystemLogRepo(pool), allowedOrigins: [ORIGIN], cookieSecure: false, trustProxy: false, sessionTtlMs: 3_600_000, tradingMode: 'paper', version: 't',
      routes: apiRoutes({ files: f, backtestResult: join(dir, 'x.json'), tradingConfig: tradingCfg, env: {}, quotes: async () => { throw new TypeError('fetch failed'); } }),
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    close = () => app.close();
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/api/market/overview`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/Market data unavailable from Yahoo Finance \(fetch failed\)/);
  });
});
