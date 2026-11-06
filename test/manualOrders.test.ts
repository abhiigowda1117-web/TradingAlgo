import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Broker } from '../src/trading/brokers/broker';
import { Engine } from '../src/trading/engine';
import { finishManualOrder, listManualOrders, pendingManualOrders, queueManualOrder, type ManualOrder } from '../src/trading/manualOrders';
import { acquireLock, processAlive, readLock, requestStop, runningEngine } from '../src/trading/runLock';
import type { Candle } from '../src/types';
import { at, EVAL, fixture, later } from './engineFixture';

const MORNING = at('2026-10-29T05:00:00Z'); // Thu 10:30 IST, before the daily evaluation

/** Fixture with the manual-order folder wired in. */
function setup(symbols?: string[]) {
  const f = fixture(symbols ? { symbols } : {});
  const dir = join(f.dir, 'manual');
  f.paths.manualOrders = dir;
  const queue = (kind: 'buy' | 'sell', symbol: string, maxQty?: number) => queueManualOrder(dir, { kind, symbol, maxQty, requestedBy: 'abhi' });
  const result = (o: ManualOrder) => listManualOrders(dir).find((x) => x.id === o.id)!;
  return { f, dir, queue, result };
}

/** A steady downtrend dated so the last bar is "today": the strategy's exit rule (EMA20 < EMA50) is true. */
function downtrend(lastDay = '2026-10-29'): Candle[] {
  const last = at(`${lastDay}T03:45:00Z`).getTime();
  return Array.from({ length: 235 }, (_, i) => {
    const close = 400 - i * 0.8 + Math.sin(i / 3) * 2;
    return { time: new Date(last - (234 - i) * 86_400_000), open: close + 0.5, high: close + 3, low: close - 3, close, volume: 100_000 };
  });
}

describe('manual paper orders from the website', () => {
  it('buys any NSE stock by hand with the risk rules and a broker-confirmed stop-loss', async () => {
    const { f, queue, result } = setup();
    f.clock = MORNING;
    const e = f.engine();
    const o = queue('buy', 'other'); // not on the watchlist; lower-case is normalised
    await e.tick();
    const p = e.state.positions.OTHER!;
    expect(p).toMatchObject({ manual: true, protection: 'confirmed' });
    expect(p.stop).toBeLessThan(p.entryPrice);
    expect((p.entryPrice - p.stop) * p.qty).toBeLessThanOrEqual(500_000 * 0.01); // the same 1% risk rule
    expect(p.qty * p.entryPrice).toBeLessThanOrEqual(500_000 * 0.2 * 1.01); // and the 20% position cap
    expect(result(o)).toMatchObject({ status: 'done', message: expect.stringMatching(/^Bought \d+ shares at ₹[\d.]+\. Stop-loss ₹[\d.]+ is active\.$/) });
    expect(f.trades()[0]).toMatchObject({ symbol: 'OTHER', side: 'BUY', manual: true, reason: 'manual buy from the website (abhi)' });
  });

  it('never buys more than asked, and never more than the risk rules allow', async () => {
    const { f, queue, result } = setup();
    f.clock = MORNING;
    const e = f.engine();
    const small = queue('buy', 'SYN', 3);
    const huge = queue('buy', 'OTHER', 100_000);
    await e.tick();
    expect(e.state.positions.SYN!.qty).toBe(3);
    expect(result(small).message).toMatch(/your limit 3/);
    expect(e.state.positions.OTHER!.qty).toBeLessThan(100_000);
    expect(result(huge).message).toMatch(/the risk rules allowed \d+ of the 100000 you asked for/);
  });

  it('refuses a second buy of the same stock, and a buy while the kill switch is on', async () => {
    const { f, queue, result } = setup();
    f.clock = MORNING;
    const e = f.engine();
    queue('buy', 'SYN');
    await e.tick();
    const again = queue('buy', 'SYN');
    f.clock = new Date(MORNING.getTime() + 60_000);
    await e.tick();
    expect(result(again)).toMatchObject({ status: 'rejected', message: 'You already hold SYN.' });
    f.killSwitch('HALT');
    const blocked = queue('buy', 'OTHER');
    f.clock = new Date(MORNING.getTime() + 120_000);
    await e.tick();
    expect(result(blocked)).toMatchObject({ status: 'rejected', message: expect.stringMatching(/New buys are blocked right now: kill switch \(halt\)/) });
    expect(e.state.positions.OTHER).toBeUndefined();
  });

  it('sells a position at market, even while new buys are paused', async () => {
    const { f, queue, result } = setup();
    f.clock = MORNING;
    const e = f.engine();
    queue('buy', 'SYN');
    await e.tick();
    const qty = e.state.positions.SYN!.qty;
    f.killSwitch('HALT');
    const sell = queue('sell', 'SYN');
    f.clock = new Date(MORNING.getTime() + 60_000);
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
    expect(await f.broker.getPositionQty('SYN')).toBe(0);
    expect(await f.workingStops('SYN')).toHaveLength(0); // the stop was cancelled first
    expect(result(sell)).toMatchObject({ status: 'done', message: `Sold ${qty} shares at market.` });
    expect(f.trades().at(-1)).toMatchObject({ side: 'SELL', qty, reason: 'manual sell from the website (abhi)' });
  });

  it('explains when there is nothing to sell or the symbol has no data', async () => {
    const { f, queue, result } = setup();
    f.clock = MORNING;
    const sell = queue('sell', 'SYN');
    const unknown = queue('buy', 'NOSUCH');
    await f.engine().tick();
    expect(result(sell)).toMatchObject({ status: 'rejected', message: 'There is no open paper position in SYN.' });
    expect(result(unknown)).toMatchObject({ status: 'rejected', message: expect.stringMatching(/No usable price data for NOSUCH today .*Check the NSE symbol/) });
  });

  it('waits while the market is closed', async () => {
    const { f, queue, result } = setup();
    f.clock = at('2026-10-31T06:00:00Z'); // Saturday
    const o = queue('buy', 'SYN');
    expect(await f.engine().tick()).toBe('closed');
    expect(result(o).status).toBe('queued');
    expect(f.broker.submits).toHaveLength(0);
  });

  it('rejects website orders when the engine runs with a live broker', async () => {
    const { f, queue, result } = setup();
    f.clock = MORNING;
    const live = new Proxy(f.broker, { get: (t, k) => (k === 'name' ? 'kite' : typeof (t as never)[k] === 'function' ? ((t as never)[k] as (...a: unknown[]) => unknown).bind(t) : (t as never)[k]) }) as unknown as Broker;
    const e = new Engine({ broker: live, market: f.market, cfg: f.cfg, paths: f.paths, now: () => f.clock, wait: async () => {} });
    const o = queue('buy', 'SYN');
    await e.tick();
    expect(result(o)).toMatchObject({ status: 'rejected', message: 'Orders from the website work in paper trading only.' });
    expect(f.broker.submits).toHaveLength(0);
  });

  it('keeps a hand-picked position on its trailing stop instead of the strategy exit rule', async () => {
    const { f, queue } = setup(['DOWN']);
    f.market.candles.DOWN = downtrend();
    f.market.ltp.DOWN = f.market.candles.DOWN.at(-1)!.close;
    f.clock = MORNING;
    const e = f.engine();
    queue('buy', 'DOWN');
    await e.tick();
    expect(e.state.positions.DOWN!.manual).toBe(true);
    f.clock = at(EVAL); // daily evaluation: EMA20 is below EMA50, which would close a strategy position
    await e.tick();
    expect(e.state.positions.DOWN).toBeDefined();
    expect(e.state.positions.DOWN!.exitReason).toBeUndefined();
  });

  it('expires an order that waited more than 30 minutes, instead of running it late', async () => {
    const { f, dir, result } = setup();
    const old = queueManualOrder(dir, { kind: 'buy', symbol: 'SYN', requestedBy: 'abhi' }, new Date(MORNING.getTime() - 31 * 60_000));
    f.clock = MORNING;
    await f.engine().tick();
    expect(result(old)).toMatchObject({ status: 'rejected', message: expect.stringMatching(/^Expired: not handled within 30 minutes/) });
    expect(f.broker.submits).toHaveLength(0);
  });

  it('rejects queued orders when "sell everything and stop" is set', async () => {
    const { f, queue, result } = setup();
    f.clock = MORNING;
    f.killSwitch('FLATTEN');
    const o = queue('buy', 'SYN');
    await f.engine().tick();
    expect(result(o)).toMatchObject({ status: 'rejected', message: expect.stringMatching(/sell everything and stop/) });
  });
});

describe('manual order queue files', () => {
  it('validates input, lists newest first, and never runs a finished request again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mo-'));
    expect(() => queueManualOrder(dir, { kind: 'buy', symbol: '../etc', requestedBy: 'a' })).toThrow(/NSE symbol/);
    expect(() => queueManualOrder(dir, { kind: 'buy', symbol: 'TCS', maxQty: 0, requestedBy: 'a' })).toThrow(/whole number/);
    expect(() => queueManualOrder(dir, { kind: 'buy', symbol: 'TCS', maxQty: 1.5, requestedBy: 'a' })).toThrow(/whole number/);
    const a = queueManualOrder(dir, { kind: 'buy', symbol: 'tcs', requestedBy: 'a' }, new Date('2026-11-06T04:00:00Z'));
    const b = queueManualOrder(dir, { kind: 'sell', symbol: 'INFY', requestedBy: 'a' }, new Date('2026-11-06T04:01:00Z'));
    expect(pendingManualOrders(dir).map((o) => o.symbol)).toEqual(['TCS', 'INFY']);
    expect(listManualOrders(dir).map((o) => o.symbol)).toEqual(['INFY', 'TCS']);
    finishManualOrder(dir, a, 'done', 'ok');
    // Simulate a crash after the outcome was written but before the request was removed.
    writeFileSync(join(dir, 'inbox', `${a.id}.json`), JSON.stringify(a));
    expect(pendingManualOrders(dir).map((o) => o.id)).toEqual([b.id]);
    expect(existsSync(join(dir, 'inbox', `${a.id}.json`))).toBe(false);
    expect(listManualOrders(dir).find((o) => o.id === a.id)!.status).toBe('done');
  });
});

describe('engine run lock and stop request', () => {
  it('lets only one live engine hold the lock; a crashed engine\'s lock is taken over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-'));
    const path = join(dir, 'engine.lock');
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: 'x', startedBy: 'terminal', mode: 'paper' }));
    const second = acquireLock(path, { startedBy: 'website', mode: 'paper' }, 999_999_1);
    expect(second).toMatchObject({ ok: false, holder: { pid: process.pid, startedBy: 'terminal' } });
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 'x', startedBy: 'terminal', mode: 'paper' })); // dead process
    expect(runningEngine(path)).toBeUndefined();
    expect(acquireLock(path, { startedBy: 'website', mode: 'paper' })).toEqual({ ok: true });
    expect(readLock(path)).toMatchObject({ pid: process.pid, startedBy: 'website', mode: 'paper' });
  });

  it('stops the run loop cleanly when a stop is requested', async () => {
    const f = fixture();
    f.paths.stopRequest = join(f.dir, 'stop-request');
    f.clock = later(1);
    requestStop(f.paths.stopRequest, 'abhi');
    await f.engine().run(); // returns instead of looping forever
    expect(existsSync(f.paths.stopRequest)).toBe(false);
  });
});
