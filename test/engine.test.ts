import { describe, expect, it } from 'vitest';
import { saveWatchlist } from '../src/study/watchlist';
import { at, entryCandles, fixture, later, watchlist } from './engineFixture';

describe('engine', () => {
  it('buys a watchlist stock on its entry signal and gets a broker-confirmed stop', async () => {
    const f = fixture();
    const e = f.engine();
    expect(await e.tick()).toBe('ok');
    const p = e.state.positions.SYN!;
    expect(p.qty).toBeGreaterThan(0);
    expect(p.stop).toBeLessThan(p.entryPrice);
    expect(p.protection).toBe('confirmed');
    expect(p.protectedQty).toBe(p.qty);
    expect(await f.broker.getPositionQty('SYN')).toBe(p.qty);
    expect(await f.workingStops('SYN')).toHaveLength(1);
    // Risk check: a stop-out (with costs and slippage) loses no more than 1% of equity.
    expect((p.entryPrice - p.stop) * p.qty).toBeLessThanOrEqual(500_000 * 0.01);
    expect(f.trades()[0]).toMatchObject({ symbol: 'SYN', side: 'BUY', qty: p.qty, broker: 'paper' });
  });

  it('only buys what the company study approved', async () => {
    const f = fixture();
    saveWatchlist(f.paths.watchlist, watchlist(['OTHER']));
    const e = f.engine();
    await e.tick();
    expect(Object.keys(e.state.positions)).toEqual(['OTHER']);
  });

  it('refuses new entries from a stale watchlist', async () => {
    const f = fixture();
    saveWatchlist(f.paths.watchlist, watchlist(['SYN'], '2026-10-01T00:00:00Z'));
    const e = f.engine();
    await e.tick();
    expect(e.state.positions).toEqual({});
    expect(f.broker.submits).toHaveLength(0);
  });

  it('evaluates only once per day and not before evaluateAt', async () => {
    const f = fixture();
    f.clock = at('2026-10-29T05:00:00Z'); // 10:30 IST
    const e = f.engine();
    await e.tick();
    expect(e.state.positions).toEqual({});
    f.clock = at('2026-10-29T09:45:00Z');
    await e.tick();
    const qty = e.state.positions.SYN!.qty;
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN!.qty).toBe(qty);
    expect(f.broker.submitsOf('BUY')).toHaveLength(1);
  });

  it('closes the position when the stop fills', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    const p = e.state.positions.SYN!;
    f.market.ltp.SYN = p.stop - 0.2; // through the trigger, above the stop-limit price
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
    expect(await f.broker.getPositionQty('SYN')).toBe(0);
    expect(f.trades()[1]).toMatchObject({ symbol: 'SYN', side: 'SELL', reason: 'stop hit' });
    expect(f.trades()[1]!.pnl as number).toBeLessThan(0);
  });

  it('exits at market when the stop triggers but its limit cannot fill', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    const p = e.state.positions.SYN!;
    f.market.ltp.SYN = p.stop * 0.97; // gapped below the stop-limit price
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN!.protection).toBe('none'); // triggered, not filled: not protection
    expect(f.broker.submitsOf('SELL', 'MARKET')).toHaveLength(0); // within grace period
    f.clock = later(3);
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
    expect(f.broker.submitsOf('SELL', 'MARKET')).toHaveLength(1);
    expect(await f.broker.getPositionQty('SYN')).toBe(0);
    expect(await f.workingStops('SYN')).toHaveLength(0);
  });

  it('re-arms the expired DAY stop on the next trading day, exactly once', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    const first = e.state.positions.SYN!.stopIntentId;
    f.market.candles.SYN = entryCandles('2026-10-30');
    f.clock = at('2026-10-30T04:00:00Z'); // Fri 09:30 IST
    await e.tick();
    f.clock = at('2026-10-30T04:01:00Z');
    await e.tick();
    const p = e.state.positions.SYN!;
    expect(p.stopIntentId).not.toBe(first);
    expect(p.protection).toBe('confirmed');
    expect(await f.workingStops('SYN')).toHaveLength(1);
    expect(f.broker.submitsOf('SELL', 'SL')).toHaveLength(2);
  });

  it('exits at the open if price has already gapped through the stop', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    f.market.ltp.SYN = e.state.positions.SYN!.stop * 0.95;
    f.clock = at('2026-10-30T04:00:00Z');
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
    expect(f.trades()[1]).toMatchObject({ side: 'SELL', reason: expect.stringMatching(/at or below stop/) });
  });

  it('does nothing while the market is closed', async () => {
    const f = fixture();
    f.clock = at('2026-10-31T06:00:00Z'); // Saturday
    expect(await f.engine().tick()).toBe('closed');
    expect(f.broker.submits).toHaveLength(0);
  });

  it('persists state across restarts', async () => {
    const f = fixture();
    await f.engine().tick();
    const restarted = f.engine();
    expect(restarted.state.positions.SYN).toBeDefined();
    expect(restarted.state.lastEvaluated).toBe('2026-10-29');
  });
});
