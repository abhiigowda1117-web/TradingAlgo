import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveWatchlist, type Watchlist } from '../src/study/watchlist';
import { PaperBroker } from '../src/trading/brokers/paperBroker';
import { Engine, type EnginePaths } from '../src/trading/engine';
import type { Candle } from '../src/types';
import { FakeMarket, syntheticCandles, tradingCfg } from './helpers';

// Thu 29 Oct 2026, 15:15 IST = 09:45 UTC
const at = (iso: string) => new Date(iso);
const EVAL = '2026-10-29T09:45:00Z';

/** Synthetic series cut at a bar where the entry signal fires, re-dated so that bar is "today". */
function entryCandles(): Candle[] {
  const c = syntheticCandles(800, { seed: 1 }).slice(0, 235);
  const last = at('2026-10-29T03:45:00Z').getTime();
  return c.map((x, i) => ({ ...x, time: new Date(last - (c.length - 1 - i) * 86_400_000) }));
}

function watchlist(symbols: string[], generatedAt = '2026-10-28T12:00:00Z'): Watchlist {
  return { generatedAt, entries: symbols.map((s) => ({ symbol: s, name: s, combinedScore: 80, fundamentalScore: 80, sentiment: 0.1 })), rejected: [] };
}

describe('engine', () => {
  let paths: EnginePaths;
  let market: FakeMarket;
  let broker: PaperBroker;
  let clock: Date;
  const engine = () => new Engine({ broker, market, cfg: tradingCfg, paths, now: () => clock });

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-'));
    paths = { watchlist: join(dir, 'watchlist.json'), state: join(dir, 'state.json'), trades: join(dir, 'trades.jsonl'), killSwitch: join(dir, 'STOP') };
    market = new FakeMarket({ SYN: entryCandles(), OTHER: entryCandles() });
    broker = new PaperBroker(market, { initialCash: 500_000, costPct: 0.0012 });
    clock = at(EVAL);
    saveWatchlist(paths.watchlist, watchlist(['SYN']));
  });

  const trades = () => readFileSync(paths.trades, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('buys a watchlist stock on its entry signal and arms a stop', async () => {
    const e = engine();
    expect(await e.tick()).toBe('ok');
    const p = e.state.positions.SYN!;
    expect(p.qty).toBeGreaterThan(0);
    expect(p.stop).toBeLessThan(p.entryPrice);
    expect(p.stopOrderId).toBeDefined();
    expect(p.stopArmedOn).toBe('2026-10-29');
    expect(await broker.getPositionQty('SYN')).toBe(p.qty);
    // Risk check: a stop-out loses about 1% of equity.
    expect((p.entryPrice - p.stop) * p.qty).toBeLessThanOrEqual(500_000 * 0.01 + 1);
    expect(trades()[0]).toMatchObject({ symbol: 'SYN', side: 'BUY', qty: p.qty, broker: 'paper' });
  });

  it('only buys what the company study approved', async () => {
    saveWatchlist(paths.watchlist, watchlist(['OTHER']));
    market.candles.SYN = entryCandles();
    const e = engine();
    await e.tick();
    expect(Object.keys(e.state.positions)).toEqual(['OTHER']);
  });

  it('refuses new entries from a stale or missing watchlist', async () => {
    saveWatchlist(paths.watchlist, watchlist(['SYN'], '2026-10-01T00:00:00Z'));
    const e = engine();
    await e.tick();
    expect(e.state.positions).toEqual({});
  });

  it('evaluates only once per day and not before evaluateAt', async () => {
    clock = at('2026-10-29T05:00:00Z'); // 10:30 IST
    const e = engine();
    await e.tick();
    expect(e.state.positions).toEqual({});
    clock = at(EVAL);
    await e.tick();
    const qty = e.state.positions.SYN!.qty;
    await e.tick();
    expect(e.state.positions.SYN!.qty).toBe(qty);
    expect(trades()).toHaveLength(1);
  });

  it('closes the position when the stop triggers', async () => {
    const e = engine();
    await e.tick();
    const p = e.state.positions.SYN!;
    market.ltp.SYN = p.stop - 1;
    clock = at('2026-10-29T09:50:00Z');
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
    expect(await broker.getPositionQty('SYN')).toBe(0);
    expect(trades()[1]).toMatchObject({ symbol: 'SYN', side: 'SELL', reason: 'stop hit' });
    expect(trades()[1].pnl).toBeLessThan(0);
  });

  it('re-arms the expired DAY stop order on the next trading day', async () => {
    const e = engine();
    await e.tick();
    const first = e.state.positions.SYN!.stopOrderId;
    clock = at('2026-10-30T04:00:00Z'); // Fri 09:30 IST
    await e.tick();
    expect(e.state.positions.SYN!.stopArmedOn).toBe('2026-10-30');
    expect(e.state.positions.SYN!.stopOrderId).not.toBe(first);
  });

  it('exits at the open if price has already gapped through the stop', async () => {
    const e = engine();
    await e.tick();
    market.ltp.SYN = e.state.positions.SYN!.stop * 0.95;
    clock = at('2026-10-30T04:00:00Z');
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
    expect(trades()[1]).toMatchObject({ side: 'SELL', reason: expect.stringMatching(/already below stop/) });
  });

  it('drops positions closed outside the engine', async () => {
    const e = engine();
    await e.tick();
    await broker.cancelOrder(e.state.positions.SYN!.stopOrderId!);
    await broker.marketOrder('SYN', 'SELL', e.state.positions.SYN!.qty);
    clock = at('2026-10-29T09:50:00Z');
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
  });

  it('does nothing when the market is closed and stops on the kill switch', async () => {
    clock = at('2026-10-31T06:00:00Z'); // Saturday
    expect(await engine().tick()).toBe('closed');
    writeFileSync(paths.killSwitch, '');
    expect(await engine().tick()).toBe('stopped');
  });

  it('persists state across restarts', async () => {
    await engine().tick();
    const restarted = engine();
    expect(restarted.state.positions.SYN).toBeDefined();
    expect(restarted.state.lastEvaluated).toBe('2026-10-29');
  });
});
