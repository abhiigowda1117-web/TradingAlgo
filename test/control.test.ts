import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DataType, newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { migrate } from '../src/server/db/migrate';
import { SessionRepo, SystemLogRepo, UserRepo } from '../src/server/db/repositories';
import { apiActions, apiRoutes, type RouteDeps } from '../src/server/routes';
import { ControlService, type SpawnFn } from '../src/server/services/control';
import { pendingManualOrders } from '../src/trading/manualOrders';
import { ROOT } from '../src/config';
import { tradingCfg } from './helpers';

const PASSWORD = 'correct horse battery';
const OPEN = new Date('2026-11-06T05:00:00Z'); // Fri 10:30 IST
const CLOSED = new Date('2026-11-07T05:00:00Z'); // Saturday

/** A child process stand-in: the test decides what it prints and when it exits. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill() {
    this.killed = true;
    this.finish(null);
    return true;
  }
  print(line: string) {
    this.stdout.write(`${line}\n`);
  }
  finish(code: number | null) {
    this.exitCode = code ?? 1;
    this.emit('close', code);
  }
}

let close: (() => void) | undefined;
afterEach(() => close?.());

async function setup(opts: { mode?: 'paper' | 'live'; now?: Date } = {}) {
  const mem = newDb();
  mem.public.registerOperator({ operator: '~', left: DataType.text, right: DataType.text, returns: DataType.bool, implementation: (a: string, b: string) => new RegExp(b).test(a) });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool, 'db/migrations');
  const users = new UserRepo(pool);
  await users.upsertOwner('owner', await hashPassword(PASSWORD));
  await users.upsertOwner('friend', await hashPassword(PASSWORD), false);

  const dir = mkdtempSync(join(tmpdir(), 'ctl-'));
  const files = {
    state: join(dir, 'state.json'), paperAccount: join(dir, 'paper.json'), trades: join(dir, 'trades.jsonl'), engineLog: join(dir, 'engine.log'),
    heartbeat: join(dir, 'hb.json'), killSwitch: join(dir, 'STOP'), watchlist: join(dir, 'wl.json'),
  };
  const spawned: { args: string[]; env: NodeJS.ProcessEnv | undefined; child: FakeChild }[] = [];
  const spawn: SpawnFn = (_cmd, args, o) => {
    const child = new FakeChild();
    spawned.push({ args, env: o.env, child });
    return child as never;
  };
  const lock = join(dir, 'engine.lock');
  const control = new ControlService({ root: ROOT, engineLock: lock, engineStopRequest: join(dir, 'stop-request'), jobsLog: join(dir, 'jobs') }, { tradingMode: opts.mode ?? 'paper', spawn, stopTimeoutMs: 50 });
  const deps: RouteDeps = {
    files, backtestResult: join(dir, 'bt.json'), tradingConfig: tradingCfg, env: { TRADING_MODE: opts.mode ?? 'paper' }, quotes: async () => [],
    control, manualOrdersDir: join(dir, 'orders'), now: () => opts.now ?? OPEN,
  };
  const app = createApp({
    db: pool, users, sessions: new SessionRepo(pool, 3_600_000), logs: new SystemLogRepo(pool), allowedOrigins: ['http://localhost:5173'], cookieSecure: false, trustProxy: false,
    sessionTtlMs: 3_600_000, tradingMode: opts.mode ?? 'paper', version: 't', routes: apiRoutes(deps), actions: apiActions(deps),
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  close = () => app.close();
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const signIn = async (username: string) => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const post = (path: string, body: unknown, csrf = true) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}) }, body: JSON.stringify(body) });
    const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
    return { post, get };
  };
  /** Pretends an engine holds the lock (this test process is alive, so the lock counts as live). */
  const engineRunning = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: OPEN.toISOString(), startedBy: 'terminal', mode: 'paper' }));
  return { base, signIn, spawned, files, deps, engineRunning, pool, dir };
}

describe('website controls: who may use them', () => {
  it('requires sign-in and a CSRF token, and refuses view-only accounts', async () => {
    const s = await setup();
    expect((await fetch(`${s.base}/api/control/kill-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"halt"}' })).status).toBe(401);
    const owner = await s.signIn('owner');
    expect((await owner.post('/api/control/kill-switch', { mode: 'halt' }, false)).status).toBe(403);
    const friend = await s.signIn('friend');
    const r = await friend.post('/api/control/kill-switch', { mode: 'halt' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/view-only/);
    expect(existsSync(s.files.killSwitch)).toBe(false);
    expect(((await (await friend.get('/api/auth/me')).json()) as { user: { canControl: boolean } }).user.canControl).toBe(false);
    expect(((await (await friend.get('/api/control')).json()) as { canControl: boolean }).canControl).toBe(false);
    expect(((await (await owner.get('/api/auth/me')).json()) as { user: { canControl: boolean } }).user.canControl).toBe(true);
  });

  it('records each action with the username in the system log', async () => {
    const s = await setup();
    const owner = await s.signIn('owner');
    await owner.post('/api/control/kill-switch', { mode: 'halt' });
    const logs = (await s.pool.query(`SELECT message FROM system_logs WHERE source = 'control'`)).rows.map((r: { message: string }) => r.message);
    expect(logs).toContain('/api/control/kill-switch by owner');
  });
});

describe('website controls: kill switch', () => {
  it('pauses new buys, sets sell-everything, and resumes', async () => {
    const s = await setup();
    const owner = await s.signIn('owner');
    expect(await (await owner.post('/api/control/kill-switch', { mode: 'halt' })).json()).toEqual({ killSwitch: 'halt' });
    expect(readFileSync(s.files.killSwitch, 'utf8').trim()).toBe('HALT');
    expect(await (await owner.post('/api/control/kill-switch', { mode: 'flatten' })).json()).toEqual({ killSwitch: 'flatten' });
    expect(await (await owner.post('/api/control/kill-switch', { mode: 'off' })).json()).toEqual({ killSwitch: 'off' });
    expect(existsSync(s.files.killSwitch)).toBe(false);
    expect((await owner.post('/api/control/kill-switch', { mode: 'boom' })).status).toBe(400);
  });
});

describe('website controls: paper orders', () => {
  it('queues a buy for the running engine during market hours', async () => {
    const s = await setup();
    s.engineRunning();
    const owner = await s.signIn('owner');
    const r = await owner.post('/api/control/order', { kind: 'buy', symbol: 'tcs', maxQty: 5 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ kind: 'buy', symbol: 'TCS', maxQty: 5, status: 'queued', requestedBy: 'owner' });
    expect(pendingManualOrders(s.deps.manualOrdersDir!)).toHaveLength(1);
    const view = (await (await owner.get('/api/control')).json()) as { orders: { symbol: string }[]; engine: { running: boolean } };
    expect(view.orders.map((o) => o.symbol)).toEqual(['TCS']);
    expect(view.engine.running).toBe(true);
  });

  it('refuses orders when the market is closed, the engine is stopped, the input is bad, or mode is live', async () => {
    const closed = await setup({ now: CLOSED });
    closed.engineRunning();
    let r = await (await closed.signIn('owner')).post('/api/control/order', { kind: 'buy', symbol: 'TCS' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/market is closed/);
    close?.();

    const stopped = await setup();
    const o = await stopped.signIn('owner');
    r = await o.post('/api/control/order', { kind: 'buy', symbol: 'TCS' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Start the engine first/);
    stopped.engineRunning();
    expect((await o.post('/api/control/order', { kind: 'buy', symbol: '../x' })).status).toBe(400);
    expect((await o.post('/api/control/order', { kind: 'short', symbol: 'TCS' })).status).toBe(400);
    expect((await o.post('/api/control/order', { kind: 'buy', symbol: 'TCS', maxQty: -3 })).status).toBe(400);
    expect(pendingManualOrders(stopped.deps.manualOrdersDir!)).toHaveLength(0);
    close?.();

    const live = await setup({ mode: 'live' });
    live.engineRunning();
    r = await (await live.signIn('owner')).post('/api/control/order', { kind: 'buy', symbol: 'TCS' });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/paper trading only/);
  });
});

describe('website controls: engine start and stop', () => {
  it('starts the paper engine as a separate program, never with --live', async () => {
    const s = await setup();
    const owner = await s.signIn('owner');
    expect((await owner.post('/api/control/engine/start', {})).status).toBe(200);
    expect(s.spawned).toHaveLength(1);
    expect(s.spawned[0]!.args.at(-1)).toBe('src/cli/trade.ts');
    expect(s.spawned[0]!.args).not.toContain('--live');
    expect(s.spawned[0]!.env?.ALGOTRADE_STARTED_BY).toBe('website (owner)');
    // A second start while the first is still starting is refused.
    expect((await owner.post('/api/control/engine/start', {})).status).toBe(409);
  });

  it('refuses to start in live mode or when an engine already runs; stop asks the engine to stop', async () => {
    const live = await setup({ mode: 'live' });
    let r = await (await live.signIn('owner')).post('/api/control/engine/start', {});
    expect(r.status).toBe(403);
    expect(live.spawned).toHaveLength(0);
    close?.();

    const s = await setup();
    const owner = await s.signIn('owner');
    expect((await owner.post('/api/control/engine/stop', {})).status).toBe(409); // nothing to stop
    s.engineRunning();
    r = await owner.post('/api/control/engine/start', {});
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/already running \(started from a terminal\)/);
    r = await owner.post('/api/control/engine/stop', {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as { stopRequested: boolean }).stopRequested).toBe(true);
    expect(existsSync(join(s.dir, 'stop-request'))).toBe(true);
  });

  it('shows why an engine started from the website exited', async () => {
    const s = await setup();
    const owner = await s.signIn('owner');
    await owner.post('/api/control/engine/start', {});
    const c = s.spawned[0]!.child;
    c.print('Invalid config/trading.json: risk.maxOpenPositions must be positive');
    await new Promise((r) => setTimeout(r, 20));
    c.finish(1);
    const view = (await (await owner.get('/api/control')).json()) as { engine: { running: boolean; lastExit: { code: number; lines: string[] } } };
    expect(view.engine.running).toBe(false);
    expect(view.engine.lastExit).toMatchObject({ code: 1, lines: ['Invalid config/trading.json: risk.maxOpenPositions must be positive'] });
  });
});

describe('website controls: jobs', () => {
  it('runs one job at a time and reports its output and result', async () => {
    const s = await setup();
    const owner = await s.signIn('owner');
    let r = await owner.post('/api/control/job', { job: 'study' });
    expect(r.status).toBe(200);
    expect(s.spawned[0]!.args.at(-1)).toBe('src/cli/study.ts');
    expect((await owner.post('/api/control/job', { job: 'backtest' })).status).toBe(409);
    expect((await owner.post('/api/control/job', { job: 'rm -rf' })).status).toBe(400);
    const c = s.spawned[0]!.child;
    c.print('\u001b[32m[1/43] RELIANCE\u001b[0m combined 63.3');
    c.print('Watchlist (10) -> data/watchlist.json');
    await new Promise((res) => setTimeout(res, 20));
    c.finish(0);
    const view = (await (await owner.get('/api/control')).json()) as { job: { job: string; state: string; lines: string[] } };
    expect(view.job).toMatchObject({ job: 'study', state: 'succeeded', lines: ['[1/43] RELIANCE combined 63.3', 'Watchlist (10) -> data/watchlist.json'] });
    r = await owner.post('/api/control/job', { job: 'backtest' });
    expect(r.status).toBe(200);
    expect(s.spawned[1]!.args.slice(-3)).toEqual(['src/cli/portfolio.ts', '--json', 'data/backtests/latest.json']);
  });
});
