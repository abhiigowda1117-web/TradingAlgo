import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TradingConfig } from '../src/config';
import { saveWatchlist, type Watchlist } from '../src/study/watchlist';
import { PaperBroker, type PaperOptions } from '../src/trading/brokers/paperBroker';
import { Engine, type EnginePaths } from '../src/trading/engine';
import type { Candle } from '../src/types';
import { FakeMarket, FaultyBroker, syntheticCandles, tradingCfg } from './helpers';

// Thu 29 Oct 2026, 15:15 IST = 09:45 UTC (after evaluateAt 15:10)
export const EVAL = '2026-10-29T09:45:00Z';
export const at = (iso: string) => new Date(iso);
/** Minutes after EVAL on the same day. */
export const later = (min: number) => new Date(at(EVAL).getTime() + min * 60_000);

/** Synthetic series cut at a bar where the entry signal fires, re-dated so that bar is "today". */
export function entryCandles(lastDay = '2026-10-29'): Candle[] {
  const c = syntheticCandles(800, { seed: 1 }).slice(0, 235);
  const last = at(`${lastDay}T03:45:00Z`).getTime();
  return c.map((x, i) => ({ ...x, time: new Date(last - (c.length - 1 - i) * 86_400_000) }));
}

export function watchlist(symbols: string[], generatedAt = '2026-10-28T12:00:00Z'): Watchlist {
  return { generatedAt, entries: symbols.map((s) => ({ symbol: s, name: s, combinedScore: 80, fundamentalScore: 80, sentiment: 0.1 })), rejected: [] };
}

/** A paper account + faulty broker wrapper + engine, all on temp files with a controllable clock. */
export function fixture(opts: { symbols?: string[]; paper?: Partial<PaperOptions>; cfg?: TradingConfig } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-'));
  const paths: EnginePaths = { watchlist: join(dir, 'watchlist.json'), state: join(dir, 'state.json'), trades: join(dir, 'trades.jsonl'), killSwitch: join(dir, 'STOP') };
  const symbols = opts.symbols ?? ['SYN'];
  const market = new FakeMarket(Object.fromEntries(['SYN', 'OTHER', ...symbols].map((s) => [s, entryCandles()])));
  const f = {
    dir,
    paths,
    market,
    clock: at(EVAL),
    cfg: opts.cfg ?? tradingCfg,
    paperFile: join(dir, 'paper.json'),
    broker: undefined as unknown as FaultyBroker,
    /** Builds a fresh PaperBroker from the saved paper file, as after a process restart. */
    newBroker() {
      const paper = new PaperBroker(market, {
        file: f.paperFile,
        initialCash: 500_000,
        costPct: 0.0012,
        slippagePct: 0.0005,
        stopLimitBufferPct: 0.005,
        now: () => f.clock,
        ...opts.paper,
      });
      f.broker = new FaultyBroker(paper);
      return f.broker;
    },
    /** Builds an engine from the saved state file, as after a process restart. */
    engine() {
      return new Engine({ broker: f.broker, market, cfg: f.cfg, paths, now: () => f.clock, wait: async () => {} });
    },
    trades(): Record<string, unknown>[] {
      return existsSync(paths.trades) ? readFileSync(paths.trades, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    },
    killSwitch(content = '') {
      writeFileSync(paths.killSwitch, content);
    },
    /** Working stop orders at the (paper) broker for a symbol. */
    async workingStops(symbol: string) {
      const acct = JSON.parse(readFileSync(f.paperFile, 'utf8')) as { orders: Record<string, { symbol: string; type: string; status: string; qty: number }> };
      return Object.values(acct.orders).filter((o) => o.symbol === symbol && o.type === 'SL' && ['trigger_pending', 'open', 'pending'].includes(o.status));
    },
  };
  f.newBroker();
  saveWatchlist(paths.watchlist, watchlist(symbols));
  return f;
}
