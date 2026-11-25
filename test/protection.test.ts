import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTradingConfig } from '../src/config';
import { saveWatchlist } from '../src/study/watchlist';
import { Engine } from '../src/trading/engine';
import type { Candle } from '../src/types';
import { setLogFile } from '../src/util/log';
import { at, EVAL, fixture, watchlist } from './engineFixture';
import { tradingCfg } from './helpers';

/** NIFTY 50 stand-in: 260 daily closes rising (healthy) or falling (bear market). */
function nifty(trend: 'up' | 'down'): Candle[] {
  const end = at(EVAL).getTime();
  return Array.from({ length: 260 }, (_, i) => {
    const c = trend === 'up' ? 20_000 + i * 20 : 26_000 - i * 20;
    return { time: new Date(end - (259 - i) * 86_400_000), open: c, high: c, low: c, close: c, volume: 0 };
  });
}

function engineWith(f: ReturnType<typeof fixture>, index?: () => Promise<Candle[]>, cfg = f.cfg) {
  return new Engine({ broker: f.broker, market: f.market, cfg, paths: f.paths, now: () => f.clock, wait: async () => {}, ...(index ? { index } : {}) });
}
const logOf = (f: ReturnType<typeof fixture>) => {
  const file = join(f.dir, 'engine.log');
  setLogFile(file);
  return () => readFileSync(file, 'utf8');
};

describe('loss protection: market filter (do not buy in a falling market)', () => {
  it('buys while the NIFTY 50 is above its 200-day average', async () => {
    const f = fixture({ symbols: ['AAA', 'BBB'] });
    const e = engineWith(f, async () => nifty('up'));
    await e.tick();
    expect(Object.keys(e.state.positions).sort()).toEqual(['AAA', 'BBB']);
  });

  it('no new buys while the NIFTY 50 is below its 200-day average, and says why', async () => {
    const f = fixture({ symbols: ['AAA', 'BBB'] });
    const text = logOf(f);
    const e = engineWith(f, async () => nifty('down'));
    await e.tick();
    expect(Object.keys(e.state.positions)).toEqual([]);
    expect(text()).toMatch(/No new buys today: the NIFTY 50 \(\d+\) is below its 200-day average .*falling market/);
  });

  it('if the NIFTY 50 cannot be loaded, it does not buy blind', async () => {
    const f = fixture({ symbols: ['AAA'] });
    const text = logOf(f);
    const e = engineWith(f, async () => {
      throw new Error('Yahoo refused');
    });
    await e.tick();
    expect(Object.keys(e.state.positions)).toEqual([]);
    expect(text()).toMatch(/could not be loaded \(Yahoo refused\)/);
  });

  it('can be switched off in config/trading.json', async () => {
    const f = fixture({ symbols: ['AAA'] });
    const e = engineWith(f, async () => nifty('down'), { ...tradingCfg, protection: { marketFilter: false } });
    await e.tick();
    expect(Object.keys(e.state.positions)).toEqual(['AAA']);
  });
});

describe('loss protection: drawdown brake', () => {
  it('no new buys while the account is 10% or more below its best value', async () => {
    const f = fixture({ symbols: ['AAA'] });
    const text = logOf(f);
    const e = engineWith(f);
    e.state.peakEquity = 600_000; // the paper account is at 5,00,000: 16.7% below
    await e.tick();
    expect(Object.keys(e.state.positions)).toEqual([]);
    expect(text()).toMatch(/16\.7% below its highest value .*drawdown brake/);
  });

  it('buys again once it is back within 10% of the best value', async () => {
    const f = fixture({ symbols: ['AAA'] });
    const e = engineWith(f);
    e.state.peakEquity = 540_000; // 7.4% below
    await e.tick();
    expect(Object.keys(e.state.positions)).toEqual(['AAA']);
  });
});

describe('loss protection: at most 3 companies per sector', () => {
  it('spreads the money: a 4th bank is skipped, a company from another sector is bought', async () => {
    const f = fixture({ symbols: ['BANK1', 'BANK2', 'BANK3', 'BANK4', 'PHARMA'] });
    const wl = watchlist(['BANK1', 'BANK2', 'BANK3', 'BANK4', 'PHARMA']);
    wl.entries = wl.entries.map((x) => ({ ...x, sector: x.symbol.startsWith('BANK') ? 'Financial Services' : 'Healthcare' }));
    saveWatchlist(f.paths.watchlist, wl);
    const text = logOf(f);
    const e = engineWith(f, undefined, { ...tradingCfg, risk: { ...tradingCfg.risk, maxPositionPct: 0.1, maxTotalExposurePct: 0.9 } });
    await e.tick();
    expect(Object.keys(e.state.positions).sort()).toEqual(['BANK1', 'BANK2', 'BANK3', 'PHARMA']);
    expect(e.state.positions.BANK1!.sector).toBe('Financial Services');
    expect(text()).toMatch(/BANK4 \(already 3 Financial Services companies\)/);
  });
});

describe('protection settings', () => {
  it('the shipped settings switch every layer on', () => {
    expect(loadTradingConfig().protection).toEqual({ marketFilter: true, marketSmaDays: 200, drawdownBrakePct: 0.1, maxPerSector: 3 });
  });
});

describe('the same protection in the backtests (Strategy Lab)', () => {
  it('market filter from the index: buying allowed above the 200-day average, not below', async () => {
    const { marketOkFromIndex } = await import('../src/trading/protection');
    const up = marketOkFromIndex(nifty('up'), 200);
    const down = marketOkFromIndex(nifty('down'), 200);
    const lastDay = '2026-10-29';
    expect(up(lastDay)).toBe(true);
    expect(down(lastDay)).toBe(false);
    expect(down('2026-11-01')).toBe(false); // a Sunday: uses the latest earlier close
    expect(down('2020-01-01')).toBe(true); // before any index data: cannot judge
  });

  it('with the market filter saying no on every day, the backtest buys nothing and counts the days', async () => {
    const { runPortfolioBacktest } = await import('../src/trading/portfolioBacktest');
    const { syntheticCandles } = await import('./helpers');
    const candles = { A: syntheticCandles(900, { seed: 3 }), B: syntheticCandles(900, { seed: 7 }) };
    const days = candles.A.map((x) => x.time.toISOString().slice(0, 10));
    const base = { strategy: tradingCfg.strategy, risk: tradingCfg.risk, costs: tradingCfg.backtest.costs, slippagePct: 0.0005, initialCapital: 500_000, start: days[300]!, end: days.at(-1)! };
    const free = runPortfolioBacktest(candles, base);
    expect(free.trades.length + free.open.length).toBeGreaterThan(0);
    const blocked = runPortfolioBacktest(candles, { ...base, marketOk: () => false });
    expect(blocked.trades.length + blocked.open.length).toBe(0);
    expect(blocked.protectedDays.market).toBeGreaterThan(500);
  });
});
