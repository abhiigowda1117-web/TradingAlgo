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
import { ResearchRepo, SessionRepo, SystemLogRepo, UserRepo } from '../src/server/db/repositories';
import type { ResearchReport } from '../src/research/research';
import { apiRoutes } from '../src/server/routes';
import { LARGE_CAPS, marketMovers } from '../src/research/market';
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

const PROTECTED = ['/api/quote?symbol=INFY', '/api/market/movers', '/api/research/recent', '/api/auth/me', '/api/dashboard/summary', '/api/engine/status', '/api/market/overview', '/api/watchlist', '/api/trades', '/api/backtest/latest', '/api/settings'];

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

describe('paper account before the first trade', () => {
  it('shows the starting capital instead of nothing, and says no trades yet', async () => {
    const { f, dir } = engineFixture();
    const { rmSync } = await import('node:fs');
    rmSync(f.paperAccount);
    rmSync(f.state);
    const routes = apiRoutes({ files: f, backtestResult: join(dir, 'x.json'), tradingConfig: tradingCfg, env: { PAPER_CAPITAL: '500000' }, quotes: async () => [] });
    const s = (await routes['/api/engine/status']!(new URLSearchParams(), { userId: 1, username: 'owner', csrfToken: 'x', expiresAt: new Date() })) as { cash: number; equity: number; paperAccountStarted: boolean };
    expect(s).toMatchObject({ cash: 500000, equity: 500000, paperAccountStarted: false });
  });
});

describe('company research API', () => {
  const fakeReport = (symbol: string) => ({ symbol, generatedAt: new Date().toISOString(), overview: { name: `${symbol} Ltd` } }) as unknown as ResearchReport;

  async function researchApp(research: (q: string, peers: string[]) => Promise<ResearchReport>) {
    const pool = await memoryDb();
    const users = new UserRepo(pool);
    await users.upsertOwner('owner', await hashPassword(PASSWORD));
    const { f, dir } = engineFixture();
    const app = createApp({
      db: pool, users, sessions: new SessionRepo(pool, 3_600_000), logs: new SystemLogRepo(pool), allowedOrigins: [ORIGIN], cookieSecure: false, trustProxy: false, sessionTtlMs: 3_600_000, tradingMode: 'paper', version: 't',
      routes: apiRoutes({ files: f, backtestResult: join(dir, 'x.json'), tradingConfig: tradingCfg, env: {}, quotes: async () => [], research, researchRepo: new ResearchRepo(pool) }),
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    close = () => app.close();
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const { cookie } = await signIn(base);
    const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
    return { get, base, pool };
  }

  it('requires sign-in', async () => {
    const { base } = await researchApp(async (q) => fakeReport(q));
    expect((await fetch(`${base}/api/research?q=TCS`)).status).toBe(401);
  });

  it('validates the company and peer inputs', async () => {
    const calls: string[] = [];
    const { get } = await researchApp(async (q) => (calls.push(q), fakeReport(q)));
    expect((await get('/api/research?q=')).status).toBe(400);
    expect((await get('/api/research?q=%3Cscript%3E')).status).toBe(400);
    expect((await get(`/api/research?q=${'A'.repeat(61)}`)).status).toBe(400);
    expect((await get('/api/research?q=TCS&peers=A,B,C,D,E,F,G')).status).toBe(400);
    expect((await get('/api/research?q=TCS&peers=in%20fy')).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await get('/api/research?q=HDFC%20Bank&peers=icicibank,axisbank')).status).toBe(200);
    expect(calls).toEqual(['HDFC Bank']);
  });

  it('caches for 15 minutes, refreshes on request, saves reports and lists recent ones', async () => {
    let n = 0;
    const { get, pool } = await researchApp(async () => (n++, fakeReport('TCS')));
    expect((await (await get('/api/research?q=TCS')).json()).cached).toBeUndefined();
    expect((await (await get('/api/research?q=tcs')).json()).cached).toBe(true);
    expect(n).toBe(1);
    await get('/api/research?q=TCS&refresh=1');
    expect(n).toBe(2);
    const saved = await pool.query('SELECT symbol FROM research_reports');
    expect(saved.rows.length).toBe(2);
    const recent = await (await get('/api/research/recent')).json();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ symbol: 'TCS', name: 'TCS Ltd' });
  });

  it('maps unknown companies to 404 and source outages to 502', async () => {
    const { get } = await researchApp(async (q) => {
      if (q === 'NOPE') throw new Error('No NSE company found for "NOPE"');
      throw new Error('fetch failed');
    });
    const a = await get('/api/research?q=NOPE');
    expect(a.status).toBe(404);
    expect((await a.json()).error).toMatch(/No NSE company/);
    expect((await get('/api/research?q=TCS')).status).toBe(502);
  });
});

describe('market movers board', () => {
  const q = (ticker: string, price: number | null, changePct: number | null): QuoteSnapshot => ({ ...quote(ticker, price ?? 0), price, changePct, time: '2026-11-03T09:55:00.000Z' });

  it('ranks gainers and losers by percent change, skips unpriced stocks, and keeps flat stocks off both lists', async () => {
    const book: Record<string, QuoteSnapshot> = {
      'AAA.NS': q('AAA.NS', 100, 2.5), 'BBB.NS': q('BBB.NS', 200, 4.1), 'CCC.NS': q('CCC.NS', 50, -3.2),
      'DDD.NS': q('DDD.NS', 75, -0.4), 'EEE.NS': q('EEE.NS', 10, 0), 'FFF.NS': q('FFF.NS', null, null), 'GGG.NS': q('GGG.NS', 300, 2.5),
    };
    const m = await marketMovers({ quotes: async (t) => t.map((x) => book[x]).filter(Boolean) as QuoteSnapshot[] }, {
      symbols: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'], holidays: [], now: new Date('2026-11-03T05:00:00Z'), count: 2,
    });
    expect(m.gainers.map((r) => r.symbol)).toEqual(['BBB', 'AAA']); // AAA before GGG on a tie (alphabetical)
    expect(m.losers.map((r) => r.symbol)).toEqual(['CCC', 'DDD']);
    expect(m.tape.map((r) => r.symbol)).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'GGG']);
    expect(m).toMatchObject({ scanned: 8, unavailable: 2, quoteTime: '2026-11-03T09:55:00.000Z' });
    expect(m.session.open).toBe(true); // 10:30 IST on a Tuesday
    expect(m.dataNote).toMatch(/delayed by about 15 minutes; not real-time/);
  });

  it('serves the board to signed-in users and reports outages as 502', async () => {
    const { base } = await start();
    const { cookie } = await signIn(base);
    const res = await fetch(`${base}/api/market/movers`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).scanned).toBe(LARGE_CAPS.length);
    close?.();
    const pool = await memoryDb();
    const users = new UserRepo(pool);
    await users.upsertOwner('owner', await hashPassword(PASSWORD));
    const { f, dir } = engineFixture();
    const app = createApp({
      db: pool, users, sessions: new SessionRepo(pool, 3_600_000), logs: new SystemLogRepo(pool), allowedOrigins: [ORIGIN], cookieSecure: false, trustProxy: false, sessionTtlMs: 3_600_000, tradingMode: 'paper', version: 't',
      routes: apiRoutes({ files: f, backtestResult: join(dir, 'x.json'), tradingConfig: tradingCfg, env: {}, quotes: async () => { throw new Error('Yahoo 429'); } }),
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    close = () => app.close();
    const b2 = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const s2 = await signIn(b2);
    const bad = await fetch(`${b2}/api/market/movers`, { headers: { Cookie: s2.cookie } });
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toMatch(/Yahoo Finance \(Yahoo 429\)/);
  });
});

describe('live quote for the research page', () => {
  it('validates the symbol, returns the delayed quote with the session, and maps outages to 502', async () => {
    const { f, dir } = engineFixture();
    const calls: string[][] = [];
    const ok = apiRoutes({ files: f, backtestResult: join(dir, 'x.json'), tradingConfig: tradingCfg, env: {}, now: () => new Date('2026-11-03T05:00:00Z'), quotes: async (t) => (calls.push(t), t.map((x) => quote(x, 1720.5))) });
    const s = { userId: 1, username: 'owner', csrfToken: 'x', expiresAt: new Date() };
    const r = (await ok['/api/quote']!(new URLSearchParams({ symbol: 'bajajfinsv' }), s)) as { symbol: string; price: number; changePct: number; session: { open: boolean }; dataNote: string };
    expect(r).toMatchObject({ symbol: 'BAJAJFINSV', price: 1720.5, changePct: 0.5, session: { open: true } });
    expect(r.dataNote).toMatch(/delayed by about 15 minutes; not real-time/);
    expect(calls).toEqual([['BAJAJFINSV.NS']]);
    for (const bad of ['', '../etc', 'A B', 'X'.repeat(21)]) {
      await expect(Promise.resolve(ok['/api/quote']!(new URLSearchParams({ symbol: bad }), s))).rejects.toMatchObject({ status: 400 });
    }
    const down = apiRoutes({ files: f, backtestResult: join(dir, 'x.json'), tradingConfig: tradingCfg, env: {}, quotes: async () => { throw new Error('fetch failed'); } });
    await expect(Promise.resolve(down['/api/quote']!(new URLSearchParams({ symbol: 'TCS' }), s))).rejects.toMatchObject({ status: 502 });
    const none = apiRoutes({ files: f, backtestResult: join(dir, 'x.json'), tradingConfig: tradingCfg, env: {}, quotes: async () => [] });
    await expect(Promise.resolve(none['/api/quote']!(new URLSearchParams({ symbol: 'NOPE' }), s))).rejects.toMatchObject({ status: 404 });
  });
});
