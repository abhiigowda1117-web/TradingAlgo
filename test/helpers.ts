import type { TradingConfig } from '../src/config';
import type { MarketData } from '../src/data/types';
import type { Broker, OrderRequest, OrderSnapshot } from '../src/trading/brokers/broker';
import { BrokerError } from '../src/trading/brokers/errors';
import type { PaperBroker } from '../src/trading/brokers/paperBroker';
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
  risk: { riskPerTrade: 0.01, maxPositionPct: 0.2, maxTotalExposurePct: 0.8, maxOpenPositions: 5, maxDailyLossPct: 0.02, maxOrderValue: 200000, maxPriceDeviationPct: 0.03 },
  engine: {
    evaluateAt: '15:10',
    pollSeconds: 30,
    watchlistMaxAgeDays: 7,
    product: 'CNC',
    exchange: 'NSE',
    stopLimitBufferPct: 0.005,
    orderTimeoutSeconds: 60,
    triggeredStopGraceSeconds: 60,
    holidays: [],
  },
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

export type SubmitFault = 'send-then-timeout' | 'timeout-before-send' | 'reject';

/**
 * Wraps a PaperBroker and injects failures: timeouts around order submission, rejections,
 * failing or wrong position reports, unknown order states, failing modifies. Records every
 * order submission so tests can assert nothing was sent twice.
 */
export class FaultyBroker implements Broker {
  readonly name = 'paper';
  submits: OrderRequest[] = [];
  onSubmit?: (req: OrderRequest) => SubmitFault | undefined;
  positionQty?: (symbol: string, real: number) => number;
  failPositionQty = false;
  failGetOrder = false;
  failFindByTag = false;
  failModify = false;
  orderOverride?: (snap: OrderSnapshot) => OrderSnapshot;
  cashOffset = 0;

  constructor(public inner: PaperBroker) {}

  async getCash() {
    return (await this.inner.getCash()) + this.cashOffset;
  }
  getLtp(symbols: string[]) {
    return this.inner.getLtp(symbols);
  }
  async getPositionQty(symbol: string) {
    if (this.failPositionQty) throw new BrokerError('positions: network error', false, 'network');
    const real = await this.inner.getPositionQty(symbol);
    return this.positionQty ? this.positionQty(symbol, real) : real;
  }
  async submitOrder(req: OrderRequest) {
    this.submits.push(req);
    const fault = this.onSubmit?.(req);
    if (fault === 'reject') throw new BrokerError('OrderException: rejected by RMS', true);
    if (fault === 'timeout-before-send') throw new BrokerError('timed out', false, 'timeout');
    const id = await this.inner.submitOrder(req);
    if (fault === 'send-then-timeout') throw new BrokerError('timed out', false, 'timeout');
    return id;
  }
  async getOrder(orderId: string) {
    if (this.failGetOrder) throw new BrokerError('orders: network error', false, 'network');
    const snap = await this.inner.getOrder(orderId);
    return this.orderOverride ? this.orderOverride(snap) : snap;
  }
  async findOrderByTag(tag: string) {
    if (this.failFindByTag) throw new BrokerError('orders: network error', false, 'network');
    const snap = await this.inner.findOrderByTag(tag);
    return snap && this.orderOverride ? this.orderOverride(snap) : snap;
  }
  async modifyStop(orderId: string, qty: number, trigger: number) {
    if (this.failModify) throw new BrokerError('modify: timed out', false, 'timeout');
    return this.inner.modifyStop(orderId, qty, trigger);
  }
  cancelOrder(orderId: string) {
    return this.inner.cancelOrder(orderId);
  }
  submitsOf(side: 'BUY' | 'SELL', type?: 'MARKET' | 'SL') {
    return this.submits.filter((r) => r.side === side && (!type || r.type === type));
  }
}
