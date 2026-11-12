import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, sameOriginAllowed } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { openDatabase } from '../src/server/db/open';
import { ResearchRepo, SessionRepo, SystemLogRepo, UserRepo } from '../src/server/db/repositories';
import { toSqlite } from '../src/server/db/sqlite';
import { apiRoutes } from '../src/server/routes';
import { tradingCfg } from './helpers';

const PASSWORD = 'correct horse battery';
let close: (() => void) | undefined;

/** HTTP request with a chosen Host header (fetch does not allow changing it). */
function withHost(port: number, host: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
afterEach(() => close?.());

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-'));
  return { dir, database: openDatabase({ sqlitePath: join(dir, 'data', 'algotrade.db') }) };
}

async function startApp(database: ReturnType<typeof openDatabase>, dir: string, setupCode?: string) {
  const users = new UserRepo(database.db);
  const files = { state: join(dir, 's'), paperAccount: join(dir, 'p'), trades: join(dir, 't'), engineLog: join(dir, 'l'), heartbeat: join(dir, 'h'), killSwitch: join(dir, 'STOP'), watchlist: join(dir, 'w') };
  const app = createApp({
    db: database.db, users, sessions: new SessionRepo(database.db, 3_600_000), logs: new SystemLogRepo(database.db), allowedOrigins: ['http://localhost:5173'], cookieSecure: false, trustProxy: false,
    sessionTtlMs: 3_600_000, tradingMode: 'paper', version: 't', setupCode,
    routes: apiRoutes({ files, backtestResult: join(dir, 'b'), tradingConfig: tradingCfg, env: {}, quotes: async () => [], researchRepo: new ResearchRepo(database.db), research: async (q) => ({ symbol: q.toUpperCase(), generatedAt: new Date().toISOString(), overview: { name: `${q} Ltd` } }) as never }),
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  close = () => app.close();
  return { base: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, port: (app.address() as AddressInfo).port, users };
}

describe('built-in SQLite database (no installation)', () => {
  it('translates the repositories\' SQL', () => {
    expect(toSqlite('UPDATE users SET a = $1, updated_at = now() WHERE id = $2')).toBe("UPDATE users SET a = ?1, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ?2");
  });

  it('creates the database file, migrates once, and keeps data across a restart', async () => {
    const { dir, database } = freshDb();
    expect(database.kind).toBe('sqlite');
    expect(await database.migrate()).toEqual(['001_initial', '002_view_only_accounts']);
    expect(await database.migrate()).toEqual([]);
    const users = new UserRepo(database.db);
    expect(await users.upsertOwner('abhi', await hashPassword(PASSWORD))).toBe('created');
    expect(await users.upsertOwner('friend', await hashPassword(PASSWORD), false)).toBe('created');
    await database.close();

    const again = openDatabase({ sqlitePath: join(dir, 'data', 'algotrade.db') });
    expect(await again.migrate()).toEqual([]);
    const u = new UserRepo(again.db);
    expect(await u.count()).toBe(2);
    expect((await u.findByUsername('abhi'))!.canControl).toBe(true);
    expect((await u.findByUsername('friend'))!.canControl).toBe(false);
    await expect(u.upsertOwner('Bad Name!', 'x')).rejects.toThrow(); // the CHECK constraint holds
    await again.close();
  });

  it('runs the whole website on it: sign-in, sessions, view-only flag, saved research, logs', async () => {
    const { dir, database } = freshDb();
    await database.migrate();
    const s = await startApp(database, dir);
    await s.users.upsertOwner('abhi', await hashPassword(PASSWORD));
    await s.users.upsertOwner('friend', await hashPassword(PASSWORD), false);
    const login = async (username: string) => {
      const res = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
      expect(res.status).toBe(200);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };
    const cookie = await login('abhi');
    const me = (await (await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: cookie } })).json()) as { user: { username: string; canControl: boolean } };
    expect(me.user).toEqual({ username: 'abhi', canControl: true });
    const friend = await login('friend');
    expect(((await (await fetch(`${s.base}/api/auth/me`, { headers: { Cookie: friend } })).json()) as { user: { canControl: boolean } }).user.canControl).toBe(false);
    expect((await fetch(`${s.base}/api/research?q=TCS`, { headers: { Cookie: cookie } })).status).toBe(200);
    const recent = (await (await fetch(`${s.base}/api/research/recent`, { headers: { Cookie: cookie } })).json()) as { symbol: string; name: string }[];
    expect(recent).toEqual([expect.objectContaining({ symbol: 'TCS', name: 'TCS Ltd' })]);
    const logs = (await database.db.query(`SELECT message FROM system_logs`)).rows.map((r) => (r as { message: string }).message);
    expect(logs).toContain('Signed in');
    const wrong = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'abhi', password: 'nope nope nope' }) });
    expect(wrong.status).toBe(401);
    expect((await fetch(`${s.base}/api/health`)).status).toBe(200);
  });
});

describe('first-run account in the browser', () => {
  it('only with no accounts, only at this computer, then never again', async () => {
    const { dir, database } = freshDb();
    await database.migrate();
    const s = await startApp(database, dir);
    const local = `http://localhost:${s.port}`;
    // Through "localhost" (this computer):
    expect(await (await fetch(`${local}/api/setup`)).json()).toEqual({ needsAccount: true, canCreateHere: true });
    // The same request with another Host name (as a phone or another computer would send) is refused.
    expect((await withHost(s.port, `192.168.1.10:${s.port}`, 'GET', '/api/setup')).json).toEqual({ needsAccount: true, canCreateHere: false });
    // DNS rebinding: a hostile site name pointed at 127.0.0.1 is refused too.
    expect((await withHost(s.port, `evil.example:${s.port}`, 'GET', '/api/setup')).json).toEqual({ needsAccount: true, canCreateHere: false });
    const elsewhere = await withHost(s.port, `192.168.1.10:${s.port}`, 'POST', '/api/setup/account', { username: 'evil', password: PASSWORD });
    expect(elsewhere.status).toBe(403);
    expect(await s.users.count()).toBe(0);
    const weak = await fetch(`${local}/api/setup/account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'abhi', password: 'short' }) });
    expect(weak.status).toBe(400);
    const ok = await fetch(`${local}/api/setup/account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Abhi', password: PASSWORD }) });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
    expect(((await (await fetch(`${local}/api/auth/me`, { headers: { Cookie: cookie } })).json()) as { user: { username: string } }).user.username).toBe('abhi');
    expect(await (await fetch(`${local}/api/setup`)).json()).toEqual({ needsAccount: false, canCreateHere: false });
    const second = await fetch(`${local}/api/setup/account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other', password: PASSWORD }) });
    expect(second.status).toBe(409);
    expect(await s.users.count()).toBe(1);
  });
});

describe('first account on a hosting server (SETUP_CODE)', () => {
  const CODE = 'blue-tiger-river-42';
  it('needs the right code from another address, works once, and never again', async () => {
    const { dir, database } = freshDb();
    await database.migrate();
    const s = await startApp(database, dir, CODE);
    const host = 'algotrade.example.in';
    expect((await withHost(s.port, host, 'GET', '/api/setup')).json).toEqual({ needsAccount: true, canCreateHere: true, needsSetupCode: true });
    expect((await withHost(s.port, host, 'POST', '/api/setup/account', { username: 'evil', password: PASSWORD })).status).toBe(403);
    expect((await withHost(s.port, host, 'POST', '/api/setup/account', { username: 'evil', password: PASSWORD, setupCode: 'blue-tiger-river-43' })).status).toBe(403);
    expect(await s.users.count()).toBe(0);
    const ok = await withHost(s.port, host, 'POST', '/api/setup/account', { username: 'abhi', password: PASSWORD, setupCode: CODE });
    expect(ok.status).toBe(200);
    expect(await s.users.count()).toBe(1);
    expect((await withHost(s.port, host, 'POST', '/api/setup/account', { username: 'second', password: PASSWORD, setupCode: CODE })).status).toBe(409);
    expect((await withHost(s.port, host, 'GET', '/api/setup')).json).toEqual({ needsAccount: false, canCreateHere: false });
    const logs = (await database.db.query(`SELECT message FROM system_logs`)).rows.map((r) => (r as { message: string }).message);
    expect(logs).toContain('Wrong setup code');
  });

  it('the setup code must be long enough', async () => {
    const { loadServerConfig } = await import('../src/server/config');
    expect(() => loadServerConfig({ SETUP_CODE: 'short' })).toThrow(/at least 12/);
    expect(loadServerConfig({ SETUP_CODE: CODE }).setupCode).toBe(CODE);
    expect(loadServerConfig({}).setupCode).toBeUndefined();
  });
});

describe('same-origin requests need no APP_ORIGIN setting', () => {
  it('accepts its own address for IPs, localhost and Tailscale names, never for an unknown site name', () => {
    expect(sameOriginAllowed('http://100.72.154.115:3001', '100.72.154.115:3001', [])).toBe(true);
    expect(sameOriginAllowed('http://192.168.1.10:3001', '192.168.1.10:3001', [])).toBe(true);
    expect(sameOriginAllowed('http://localhost:3001', 'localhost:3001', [])).toBe(true);
    expect(sameOriginAllowed('http://desktop-achhjq9.tail1234.ts.net:3001', 'desktop-achhjq9.tail1234.ts.net:3001', [])).toBe(true);
    expect(sameOriginAllowed('https://algotrade.example.in', 'algotrade.example.in', ['https://algotrade.example.in'])).toBe(true);
    // DNS rebinding: a hostile site name pointed at this computer.
    expect(sameOriginAllowed('http://evil.example:3001', 'evil.example:3001', [])).toBe(false);
    // Cross-origin: another page calling this server.
    expect(sameOriginAllowed('http://evil.example', '192.168.1.10:3001', [])).toBe(false);
    expect(sameOriginAllowed('not a url', '192.168.1.10:3001', [])).toBe(false);
  });
});
