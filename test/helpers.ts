import type { TradingConfig } from '../src/config';
import type { MarketData } from '../src/data/types';
import type { Candle } from '../src/types';

/** Deterministic PRNG so tests are repeatable. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Uptrend with an 80-bar cycle on top: gives periodic EMA crossovers above the 200 EMA. */
export function syntheticCandles(n: number, opts: { seed?: number; drift?: number; amp?: number; noise?: number; start?: Date } = {}): Candle[] {
  const r = rng(opts.seed ?? 7);
  const drift = opts.drift ?? 0.0008;
  const amp = opts.amp ?? 0.06;
  const noise = opts.noise ?? 0.04;
  const start = opts.start ?? new Date('2020-01-01T03:45:00Z');
  const out: Candle[] = [];
  let prevClose = 100;
  for (let t = 0; t < n; t++) {
    const close = 100 * Math.exp(drift * t) * (1 + amp * Math.sin((2 * Math.PI * t) / 80)) * (1 + (r() - 0.5) * noise);
    const open = prevClose * (1 + (r() - 0.5) * 0.004);
    const high = Math.max(open, close) * (1 + r() * 0.006);
    const low = Math.min(open, close) * (1 - r() * 0.006);
    out.push({ time: new Date(start.getTime() + t * 86_400_000), open, high, low, close, volume: 1e5 });
    prevClose = close;
  }
  return out;
}

export const tradingCfg: TradingConfig = {
  strategy: { fastEma: 20, slowEma: 50, trendEma: 200, rsiPeriod: 14, rsiMin: 50, rsiMax: 70, atrPeriod: 14, stopAtr: 2, trailAtr: 3 },
  risk: { riskPerTrade: 0.01, maxPositionPct: 0.2, maxOpenPositions: 5, maxDailyLossPct: 0.02, maxOrderValue: 200000 },
  engine: { evaluateAt: '15:10', pollSeconds: 30, watchlistMaxAgeDays: 7, product: 'CNC', exchange: 'NSE', stopLimitBufferPct: 0.005, holidays: [] },
  backtest: { initialCapital: 500000, costPct: 0.0012, slippagePct: 0.0005 },
};

/** In-memory market data with settable prices. */
export class FakeMarket implements MarketData {
  ltp: Record<string, number> = {};
  constructor(public candles: Record<string, Candle[]>) {
    for (const [s, c] of Object.entries(candles)) this.ltp[s] = c.at(-1)!.close;
  }
  async getDailyCandles(symbol: string) {
    const c = this.candles[symbol];
    if (!c) throw new Error(`no data for ${symbol}`);
    return c;
  }
  async getLtp(symbols: string[]) {
    return Object.fromEntries(symbols.filter((s) => this.ltp[s] !== undefined).map((s) => [s, this.ltp[s]!]));
  }
}
