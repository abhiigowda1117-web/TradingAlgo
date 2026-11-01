import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadTradingConfig, paths, type TradingConfig } from '../src/config';
import { positionSize, validateEntryPrice, validateTradingConfig } from '../src/trading/risk';
import { redact, registerSecret } from '../src/util/log';
import { at, entryCandles, EVAL, fixture, later } from './engineFixture';
import { tradingCfg } from './helpers';

const clone = (c: TradingConfig): TradingConfig => JSON.parse(JSON.stringify(c));

describe('duplicate order prevention', () => {
  it('a restart in the middle of the day does not buy the same stock again', async () => {
    const f = fixture();
    await f.engine().tick();
    // Simulate a crash before lastEvaluated was saved, then a restart.
    const state = JSON.parse(readFileSync(f.paths.state, 'utf8'));
    delete state.lastEvaluated;
    writeFileSync(f.paths.state, JSON.stringify(state));
    f.newBroker();
    f.clock = later(5);
    await f.engine().tick();
    expect(f.broker.submitsOf('BUY')).toHaveLength(0); // the new broker wrapper saw no BUY
    expect(await f.broker.getPositionQty('SYN')).toBe(state.positions.SYN.qty);
  });

  it('a BUY whose result was lost is reconciled by tag, never resent, even across a restart', async () => {
    const f = fixture();
    f.broker.onSubmit = (r) => (r.side === 'BUY' ? 'send-then-timeout' : undefined);
    const e = f.engine();
    await e.tick();
    const intent = Object.values(e.state.intents).find((i) => i.kind === 'entry')!;
    expect(intent.status).toBe('uncertain');
    expect(e.state.positions.SYN).toBeUndefined();

    // Restart: a new engine and broker wrapper over the same files.
    const faulty = f.broker.inner;
    f.newBroker();
    expect(f.broker.inner).not.toBe(faulty);
    f.clock = later(1);
    const e2 = f.engine();
    await e2.tick();
    expect(f.broker.submitsOf('BUY')).toHaveLength(0);
    const p = e2.state.positions.SYN!;
    expect(p.qty).toBe(intent.qty);
    expect(await f.broker.getPositionQty('SYN')).toBe(intent.qty);
    expect(p.protection).toBe('confirmed');
  });
});

describe('network timeout after order submission', () => {
  it('order reached the broker: found by tag, position recorded and protected, one order only', async () => {
    const f = fixture();
    f.broker.onSubmit = (r) => (r.side === 'BUY' ? 'send-then-timeout' : undefined);
    const e = f.engine();
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined(); // not assumed filled
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN!.qty).toBeGreaterThan(0);
    expect(e.state.positions.SYN!.protection).toBe('confirmed');
    expect(f.broker.submitsOf('BUY')).toHaveLength(1);
  });

  it('order never reached the broker: marked not_found after repeated lookups, not resent', async () => {
    const f = fixture();
    f.broker.onSubmit = (r) => (r.side === 'BUY' ? 'timeout-before-send' : undefined);
    const e = f.engine();
    await e.tick();
    for (const m of [1, 2, 3]) {
      f.clock = later(m);
      await e.tick();
    }
    const intent = Object.values(e.state.intents).find((i) => i.kind === 'entry')!;
    expect(intent.status).toBe('not_found');
    expect(f.broker.submitsOf('BUY')).toHaveLength(1);
    expect(e.state.positions).toEqual({});
    expect(await f.broker.getPositionQty('SYN')).toBe(0);
  });

  it('a definite rejection is final and not retried the same day', async () => {
    const f = fixture();
    f.broker.onSubmit = (r) => (r.side === 'BUY' ? 'reject' : undefined);
    const e = f.engine();
    await e.tick();
    expect(Object.values(e.state.intents)[0]!.status).toBe('rejected');
    const state = JSON.parse(readFileSync(f.paths.state, 'utf8'));
    delete state.lastEvaluated;
    writeFileSync(f.paths.state, JSON.stringify(state));
    f.broker.onSubmit = undefined;
    f.clock = later(1);
    await f.engine().tick();
    expect(f.broker.submitsOf('BUY')).toHaveLength(1);
  });
});

describe('partial fills', () => {
  it('a partially filled entry tracks the filled quantity and the stop covers exactly that', async () => {
    const f = fixture({ paper: { fillRatio: 0.5 } });
    const e = f.engine();
    await e.tick();
    const intent = Object.values(e.state.intents).find((i) => i.kind === 'entry')!;
    const p = e.state.positions.SYN!;
    expect(intent.status).toBe('cancelled');
    expect(intent.filledQty).toBe(Math.floor(intent.qty * 0.5));
    expect(p.qty).toBe(intent.filledQty);
    expect(await f.broker.getPositionQty('SYN')).toBe(p.qty);
    const stops = await f.workingStops('SYN');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.qty).toBe(p.qty);
    expect(f.trades()[0]).toMatchObject({ side: 'BUY', qty: p.qty });
  });

  it('a partially filled exit sells only the confirmed remainder, never more than held', async () => {
    const f = fixture({ paper: { fillRatio: 0.5 } });
    const e = f.engine();
    await e.tick();
    const qty = e.state.positions.SYN!.qty;
    f.killSwitch('FLATTEN');
    let result = '';
    for (let m = 1; m <= 30 && result !== 'stopped'; m++) {
      f.clock = later(m);
      result = await e.tick();
    }
    expect(result).toBe('stopped');
    expect(e.state.positions.SYN).toBeUndefined();
    expect(await f.broker.getPositionQty('SYN')).toBe(0);
    // Each SELL asked only for what was still held: requests halve with each partial fill.
    const requests = f.broker.submitsOf('SELL', 'MARKET').map((r) => r.qty);
    expect(requests[0]).toBe(qty);
    for (let i = 1; i < requests.length; i++) expect(requests[i]).toBeLessThan(requests[i - 1]!);
    const soldTrades = f.trades().filter((t) => t.side === 'SELL').reduce((a, t) => a + (t.qty as number), 0);
    expect(soldTrades).toBe(qty);
  });
});

describe('stop-loss protection', () => {
  it('a rejected stop leaves the position marked unprotected, blocks entries, and is retried once rejection is confirmed', async () => {
    const f = fixture({ symbols: ['SYN', 'OTHER'] });
    f.broker.onSubmit = (r) => (r.type === 'SL' ? 'reject' : undefined);
    const e = f.engine();
    await e.tick();
    expect(e.state.positions.SYN!.protection).toBe('none');
    expect(e.state.positions.OTHER).toBeUndefined(); // no further entries while unprotected
    f.broker.onSubmit = undefined;
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN!.protection).toBe('confirmed');
    expect(await f.workingStops('SYN')).toHaveLength(1);
  });

  it('after repeated stop rejections it stops retrying and exits itself when price reaches the stop', async () => {
    const f = fixture();
    f.broker.onSubmit = (r) => (r.type === 'SL' ? 'reject' : undefined);
    const e = f.engine();
    await e.tick();
    for (const m of [1, 2, 3, 4]) {
      f.clock = later(m);
      await e.tick();
    }
    expect(f.broker.submitsOf('SELL', 'SL')).toHaveLength(3);
    f.market.ltp.SYN = e.state.positions.SYN!.stop - 1;
    f.clock = later(5);
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
    expect(f.broker.submitsOf('SELL', 'MARKET')).toHaveLength(1);
  });

  it('a stop whose placement timed out is found by tag instead of being placed twice', async () => {
    const f = fixture();
    f.broker.onSubmit = (r) => (r.type === 'SL' ? 'send-then-timeout' : undefined);
    const e = f.engine();
    await e.tick();
    expect(e.state.positions.SYN!.protection).toBe('none');
    f.broker.onSubmit = undefined;
    f.clock = later(1);
    await e.tick();
    expect(f.broker.submitsOf('SELL', 'SL')).toHaveLength(1);
    expect(await f.workingStops('SYN')).toHaveLength(1);
    expect(e.state.positions.SYN!.protection).toBe('confirmed');
  });

  it('a failed stop modification keeps the broker-confirmed stop and retries', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    const p = e.state.positions.SYN!;
    const confirmed = p.protectedStop!;
    p.stop = p.stop + 1; // the strategy trails the stop up
    f.broker.failModify = true;
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN!.protectedStop).toBe(confirmed);
    expect(e.state.positions.SYN!.stop).toBeGreaterThan(confirmed);
    f.broker.failModify = false;
    f.clock = later(2);
    await e.tick();
    expect(e.state.positions.SYN!.protectedStop).toBeGreaterThan(confirmed);
    expect(await f.workingStops('SYN')).toHaveLength(1);
  });
});

describe('restart with open positions', () => {
  it('a restarted engine picks up its positions and re-protects them without duplicating stops', async () => {
    const f = fixture();
    await f.engine().tick();
    // Same day restart: existing stop is found, nothing new placed.
    f.newBroker();
    f.clock = later(10);
    let e = f.engine();
    await e.tick();
    expect(f.broker.submitsOf('SELL', 'SL')).toHaveLength(0);
    expect(e.state.positions.SYN!.protection).toBe('confirmed');
    // Next-day restart: yesterday's DAY stop has expired; exactly one new stop is placed.
    f.newBroker();
    f.market.candles.SYN = entryCandles('2026-10-30');
    f.clock = at('2026-10-30T04:00:00Z');
    e = f.engine();
    await e.tick();
    expect(f.broker.submitsOf('SELL', 'SL')).toHaveLength(1);
    expect(await f.workingStops('SYN')).toHaveLength(1);
    expect(e.state.positions.SYN!.protection).toBe('confirmed');
  });

  it('refuses to start on corrupt state instead of silently starting empty', async () => {
    const f = fixture();
    writeFileSync(f.paths.state, '{"positions": {"SYN": ');
    expect(() => f.engine()).toThrow(/not valid JSON/);
  });
});

describe('broker/local position mismatch', () => {
  it('one bad position report does not drop the position or cancel its stop', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    let calls = 0;
    f.broker.positionQty = (_s, real) => (++calls === 1 ? 0 : real);
    f.clock = later(1);
    await e.tick();
    f.clock = later(2);
    await e.tick();
    expect(e.state.positions.SYN).toBeDefined();
    expect(await f.workingStops('SYN')).toHaveLength(1);
    expect(e.state.positions.SYN!.mismatchCount).toBe(0);
  });

  it('a confirmed shortfall is adopted after consecutive checks, and entries are blocked meanwhile', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    const qty = e.state.positions.SYN!.qty;
    f.broker.positionQty = () => qty - 10;
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN!.qty).toBe(qty);
    f.clock = later(2);
    await e.tick();
    expect(e.state.positions.SYN!.qty).toBe(qty - 10);
    expect(f.trades().at(-1)).toMatchObject({ side: 'SELL', qty: 10, reason: expect.stringMatching(/outside engine/) });
  });

  it('extra shares at the broker are reported but not adopted', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    const qty = e.state.positions.SYN!.qty;
    f.broker.positionQty = (_s, real) => real + 100;
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN!.qty).toBe(qty);
  });
});

describe('daily loss limit', () => {
  it('halts new entries for the day once equity falls by maxDailyLossPct, while keeping stops', async () => {
    const f = fixture({ symbols: ['SYN', 'OTHER'] });
    f.clock = at('2026-10-29T05:00:00Z'); // 10:30 IST, before evaluation
    const e = f.engine();
    await e.tick();
    expect(e.state.dayStartEquity).toBe(500_000);
    f.broker.cashOffset = -15_000; // -3%
    f.clock = at(EVAL);
    await e.tick();
    expect(e.state.haltedOn).toBe('2026-10-29');
    expect(f.broker.submitsOf('BUY')).toHaveLength(0);
  });

  it('blocks entries when equity cannot be valued (a held position has no price)', async () => {
    const f = fixture({ symbols: ['SYN', 'OTHER'] });
    saveWatch(f, ['SYN']);
    const e = f.engine();
    await e.tick();
    expect(e.state.positions.SYN).toBeDefined();
    saveWatch(f, ['SYN', 'OTHER']);
    f.market.candles.OTHER = entryCandles('2026-10-30');
    delete f.market.ltp.SYN; // OTHER still has a valid price
    f.clock = at('2026-10-30T09:45:00Z');
    await e.tick();
    expect(e.state.positions.OTHER).toBeUndefined();
    expect(f.broker.submitsOf('BUY')).toHaveLength(1);
  });
});

describe('invalid market prices', () => {
  for (const [label, ltp] of [
    ['missing', undefined],
    ['NaN', NaN],
    ['zero', 0],
    ['negative', -5],
    ['far from the candle close', 200],
  ] as const) {
    it(`does not enter when the live price is ${label}`, async () => {
      const f = fixture();
      if (ltp === undefined) delete f.market.ltp.SYN;
      else f.market.ltp.SYN = ltp;
      const e = f.engine();
      await e.tick();
      expect(f.broker.submits).toHaveLength(0);
      expect(e.state.positions).toEqual({});
    });
  }

  it('sizing returns zero shares for invalid inputs', () => {
    const r = tradingCfg.risk;
    expect(positionSize({ equity: NaN, cash: 1e6, price: 100, stop: 95 }, r).qty).toBe(0);
    expect(positionSize({ equity: 1e6, cash: NaN, price: 100, stop: 95 }, r).qty).toBe(0);
    expect(positionSize({ equity: 1e6, cash: 1e6, price: Infinity, stop: 95 }, r).qty).toBe(0);
    expect(positionSize({ equity: 1e6, cash: 1e6, price: 100, stop: -1 }, r).qty).toBe(0);
    expect(positionSize({ equity: -5, cash: 1e6, price: 100, stop: 95 }, r).qty).toBe(0);
    expect(validateEntryPrice(100, 100.5, 0.03)).toBeUndefined();
    expect(validateEntryPrice(110, 100, 0.03)).toMatch(/from candle close/);
  });

  it('costs and slippage reduce the position so worst-case stop loss stays within risk', () => {
    const r = tradingCfg.risk;
    const plain = positionSize({ equity: 1e6, cash: 1e6, price: 1000, stop: 950 }, { ...r, maxPositionPct: 1, maxOrderValue: 1e9 }).qty;
    const costed = positionSize({ equity: 1e6, cash: 1e6, price: 1000, stop: 950 }, { ...r, maxPositionPct: 1, maxOrderValue: 1e9 }, { costPct: 0.0012, slippagePct: 0.0005, stopBufferPct: 0.005 }).qty;
    expect(costed).toBeLessThan(plain);
    const worstLoss = costed * (1000 * 1.0005 - 950 * 0.995 * 0.9995 + (1000 * 1.0005 + 950 * 0.995 * 0.9995) * 0.0012);
    expect(worstLoss).toBeLessThanOrEqual(1e6 * r.riskPerTrade);
  });

  it('enforces the total exposure cap', () => {
    const r = tradingCfg.risk; // 80% max exposure
    expect(positionSize({ equity: 1e6, cash: 1e6, price: 1000, stop: 900, exposure: 790_000 }, r)).toMatchObject({ qty: 10, reason: 'sized by total exposure limit' });
    expect(positionSize({ equity: 1e6, cash: 1e6, price: 1000, stop: 900, exposure: 800_000 }, r).qty).toBe(0);
  });
});

describe('failed broker reconciliation', () => {
  it('a failing position lookup changes nothing and blocks entries', async () => {
    const f = fixture({ symbols: ['SYN', 'OTHER'] });
    saveWatch(f, ['SYN']);
    const e = f.engine();
    await e.tick();
    saveWatch(f, ['SYN', 'OTHER']);
    f.broker.failPositionQty = true;
    f.clock = at('2026-10-30T04:00:00Z');
    f.market.candles.OTHER = entryCandles('2026-10-30');
    await e.tick();
    f.clock = at('2026-10-30T09:45:00Z');
    await e.tick();
    expect(e.state.positions.SYN).toBeDefined();
    expect(e.state.positions.OTHER).toBeUndefined();
    expect(f.broker.submitsOf('BUY')).toHaveLength(1); // only day one's SYN entry
    expect(e.state.positions.SYN!.protection).toBe('confirmed'); // stops still managed
  });

  it('a failing order lookup leaves the intent unresolved and blocks entries', async () => {
    const f = fixture({ symbols: ['SYN', 'OTHER'] });
    f.broker.onSubmit = (r) => (r.side === 'BUY' && r.symbol === 'SYN' ? 'send-then-timeout' : undefined);
    f.broker.failFindByTag = true;
    const e = f.engine();
    await e.tick();
    f.clock = later(5);
    await e.tick();
    const intent = Object.values(e.state.intents).find((i) => i.symbol === 'SYN')!;
    expect(intent.status).toBe('uncertain');
    expect(e.state.positions.OTHER).toBeUndefined();
    expect(f.broker.submitsOf('BUY')).toHaveLength(1);
  });
});

describe('unknown order status', () => {
  it('a stop in an unrecognised state is not treated as protection and is not duplicated', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    f.broker.orderOverride = (s) => (s.side === 'SELL' ? { ...s, status: 'unknown' } : s);
    f.clock = later(1);
    await e.tick();
    expect(e.state.positions.SYN!.protection).toBe('none');
    expect(f.broker.submitsOf('SELL', 'SL')).toHaveLength(1);
    f.broker.orderOverride = undefined;
    f.clock = later(2);
    await e.tick();
    expect(e.state.positions.SYN!.protection).toBe('confirmed');
    expect(f.broker.submitsOf('SELL', 'SL')).toHaveLength(1);
  });

  it('an entry in an unrecognised state is not treated as filled', async () => {
    const f = fixture();
    f.broker.orderOverride = (s) => (s.side === 'BUY' ? { ...s, status: 'unknown', filledQty: 0, avgPrice: 0 } : s);
    const e = f.engine();
    await e.tick();
    expect(e.state.positions.SYN).toBeUndefined();
    expect(Object.values(e.state.intents)[0]!.status).toBe('unknown');
  });
});

describe('kill switch', () => {
  it('HALT blocks new entries but keeps managing and re-protecting existing positions', async () => {
    const f = fixture({ symbols: ['SYN'] });
    const e = f.engine();
    await e.tick();
    f.killSwitch();
    saveWatch(f, ['SYN', 'OTHER']);
    f.market.candles.OTHER = entryCandles('2026-10-30');
    f.clock = at('2026-10-30T04:00:00Z');
    expect(await e.tick()).toBe('halted');
    expect(e.state.positions.SYN!.protection).toBe('confirmed'); // stop re-armed for the new day
    f.clock = at('2026-10-30T09:45:00Z');
    await e.tick();
    expect(e.state.positions.OTHER).toBeUndefined();
    expect(f.broker.submitsOf('BUY')).toHaveLength(1);
  });

  it('FLATTEN cancels the stop, sells everything once, and stops the engine', async () => {
    const f = fixture();
    const e = f.engine();
    await e.tick();
    f.killSwitch('FLATTEN');
    f.clock = later(1);
    let r = await e.tick();
    if (r !== 'stopped') r = await e.tick();
    expect(r).toBe('stopped');
    expect(await f.broker.getPositionQty('SYN')).toBe(0);
    expect(await f.workingStops('SYN')).toHaveLength(0);
    expect(f.broker.submitsOf('SELL', 'MARKET')).toHaveLength(1);
  });

  it('a kill switch dropped in during evaluation stops further entries', async () => {
    const f = fixture({ symbols: ['SYN', 'OTHER'] });
    f.broker.onSubmit = (r) => {
      if (r.side === 'BUY') f.killSwitch();
      return undefined;
    };
    await f.engine().tick();
    expect(f.broker.submitsOf('BUY')).toHaveLength(1);
  });
});

describe('configuration validation', () => {
  it('accepts the shipped config', () => {
    expect(() => loadTradingConfig(paths.tradingConfig)).not.toThrow();
    expect(validateTradingConfig(tradingCfg)).toEqual([]);
  });

  it('rejects unsafe or malformed values', () => {
    const bad = clone(tradingCfg);
    bad.risk.riskPerTrade = 0.5;
    bad.risk.maxDailyLossPct = NaN;
    bad.risk.maxOpenPositions = 2.5;
    bad.strategy.fastEma = 60;
    bad.engine.pollSeconds = 0;
    bad.engine.evaluateAt = '18:00';
    const errs = validateTradingConfig(bad).join('\n');
    expect(errs).toMatch(/riskPerTrade/);
    expect(errs).toMatch(/maxDailyLossPct/);
    expect(errs).toMatch(/maxOpenPositions/);
    expect(errs).toMatch(/fastEma must be less than/);
    expect(errs).toMatch(/pollSeconds/);
    expect(errs).toMatch(/evaluateAt/);
  });
});

describe('secret handling', () => {
  it('masks registered secrets and credential patterns in log lines', () => {
    registerSecret('myAccessToken123');
    expect(redact('call failed for myAccessToken123')).toBe('call failed for ***');
    expect(redact('Authorization: token abc:def')).toBe('Authorization: token ***');
    expect(redact('url?api_key=xyz&request_token=qqq')).toBe('url?api_key=***&request_token=***');
  });
});

function saveWatch(f: ReturnType<typeof fixture>, symbols: string[]) {
  const generatedAt = '2026-10-29T12:00:00Z';
  writeFileSync(f.paths.watchlist, JSON.stringify({ generatedAt, entries: symbols.map((s) => ({ symbol: s, name: s, combinedScore: 80, fundamentalScore: 80, sentiment: 0.1 })), rejected: [] }));
}
