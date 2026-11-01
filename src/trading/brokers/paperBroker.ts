import type { MarketData } from '../../data/types';
import { readJson, writeJsonAtomic } from '../../util/fs';
import { istParts } from '../../util/time';
import { BrokerError } from './errors';
import { stopLimitPrice, toTick, TERMINAL, type Broker, type OrderRequest, type OrderSnapshot } from './broker';

interface PaperOrder extends OrderSnapshot {
  type: 'MARKET' | 'SL';
  limit?: number;
  /** IST trading day the order was placed; working orders expire at the end of it, like Kite DAY orders. */
  day: string;
}

interface PaperAccount {
  cash: number;
  positions: Record<string, number>;
  orders: Record<string, PaperOrder>;
  nextId: number;
}

export interface PaperOptions {
  file?: string;
  initialCash: number;
  /** Brokerage, STT and charges as a fraction of traded value, per side. */
  costPct: number;
  /** Adverse slippage applied to every fill. */
  slippagePct: number;
  stopLimitBufferPct: number;
  /** Fraction of a market order that fills (the rest is cancelled), to simulate partial fills. Default 1. */
  fillRatio?: number;
  now?: () => Date;
}

/**
 * Simulated broker with Kite-like semantics: market orders fill at LTP plus slippage (optionally
 * partially), stop-limit sells trigger when a polled LTP reaches the trigger and fill only if the
 * price is still at or above the limit, and sells beyond free holdings are rejected.
 */
export class PaperBroker implements Broker {
  readonly name = 'paper';
  private acct: PaperAccount;

  constructor(
    private data: MarketData,
    private opts: PaperOptions,
  ) {
    const saved = opts.file ? readJson<PaperAccount & { stops?: unknown }>(opts.file) : undefined;
    if (saved && !saved.orders) {
      throw new Error(`${opts.file} uses an older paper-account format. Delete it and data/state.json to start a fresh paper account.`);
    }
    this.acct = saved ?? { cash: opts.initialCash, positions: {}, orders: {}, nextId: 1 };
  }

  private today = () => istParts(this.opts.now?.() ?? new Date()).date;

  /** Working orders from an earlier trading day are cancelled, as the exchange does with DAY orders. */
  private expireOld() {
    const today = this.today();
    for (const o of Object.values(this.acct.orders)) {
      if (!TERMINAL.has(o.status) && o.day < today) {
        o.status = 'cancelled';
        o.message = 'DAY order expired';
      }
    }
  }

  private save() {
    if (this.opts.file) writeJsonAtomic(this.opts.file, this.acct);
  }

  async getCash() {
    return this.acct.cash;
  }

  getLtp(symbols: string[]) {
    return this.data.getLtp(symbols);
  }

  async getPositionQty(symbol: string) {
    return this.acct.positions[symbol] ?? 0;
  }

  private async price(symbol: string): Promise<number> {
    const p = (await this.data.getLtp([symbol]))[symbol];
    if (p === undefined || !Number.isFinite(p) || p <= 0) throw new BrokerError(`No valid price for ${symbol}`, false);
    return p;
  }

  /** Holdings not already promised to working sell orders. */
  private freeQty(symbol: string, exceptId?: string): number {
    this.expireOld();
    const reserved = Object.values(this.acct.orders)
      .filter((o) => o.symbol === symbol && o.side === 'SELL' && !TERMINAL.has(o.status) && o.orderId !== exceptId)
      .reduce((a, o) => a + (o.qty - o.filledQty), 0);
    return (this.acct.positions[symbol] ?? 0) - reserved;
  }

  private fill(o: PaperOrder, qty: number, rawPrice: number) {
    const price = o.side === 'BUY' ? rawPrice * (1 + this.opts.slippagePct) : rawPrice * (1 - this.opts.slippagePct);
    const value = qty * price;
    const cost = value * this.opts.costPct;
    const held = this.acct.positions[o.symbol] ?? 0;
    if (o.side === 'BUY') {
      this.acct.cash -= value + cost;
      this.acct.positions[o.symbol] = held + qty;
    } else {
      this.acct.cash += value - cost;
      this.acct.positions[o.symbol] = held - qty;
    }
    o.avgPrice = (o.avgPrice * o.filledQty + price * qty) / (o.filledQty + qty);
    o.filledQty += qty;
  }

  async submitOrder(req: OrderRequest): Promise<string> {
    if (!Number.isInteger(req.qty) || req.qty <= 0) throw new BrokerError(`Invalid quantity ${req.qty}`, true);
    const orderId = `paper-${this.acct.nextId++}`;
    const o: PaperOrder = { orderId, tag: req.tag, symbol: req.symbol, side: req.side, qty: req.qty, filledQty: 0, avgPrice: 0, status: 'pending', type: req.type, day: this.today() };
    this.acct.orders[orderId] = o;

    if (req.side === 'SELL' && req.qty > this.freeQty(req.symbol, orderId)) {
      o.status = 'rejected';
      o.message = 'Insufficient holdings';
    } else if (req.type === 'SL') {
      o.trigger = toTick(req.trigger);
      o.limit = stopLimitPrice(req.trigger, this.opts.stopLimitBufferPct);
      o.status = 'trigger_pending';
    } else {
      const price = await this.price(req.symbol);
      const want = Math.max(1, Math.floor(req.qty * (this.opts.fillRatio ?? 1)));
      const est = want * price * (1 + this.opts.slippagePct) * (1 + this.opts.costPct);
      if (req.side === 'BUY' && est > this.acct.cash) {
        o.status = 'rejected';
        o.message = 'Insufficient funds';
      } else {
        if (want > 0) this.fill(o, want, price);
        o.status = o.filledQty === o.qty ? 'complete' : 'cancelled';
        if (o.status === 'cancelled') o.message = `Partially filled ${o.filledQty}/${o.qty}; remainder cancelled`;
      }
    }
    this.save();
    return orderId;
  }

  /** Advances a working stop order against the current price. */
  private async process(o: PaperOrder) {
    this.expireOld();
    if (o.type !== 'SL' || TERMINAL.has(o.status)) return;
    const price = await this.price(o.symbol);
    if (o.status === 'trigger_pending' && price <= o.trigger!) o.status = 'open';
    if (o.status === 'open' && price >= o.limit!) {
      const qty = Math.min(o.qty - o.filledQty, this.acct.positions[o.symbol] ?? 0);
      if (qty > 0) this.fill(o, qty, price);
      if (o.filledQty >= o.qty || (this.acct.positions[o.symbol] ?? 0) === 0) o.status = 'complete';
    }
    this.save();
  }

  async getOrder(orderId: string): Promise<OrderSnapshot> {
    const o = this.acct.orders[orderId];
    if (!o) throw new BrokerError(`Unknown order ${orderId}`, false);
    await this.process(o);
    return { ...o };
  }

  async findOrderByTag(tag: string): Promise<OrderSnapshot | undefined> {
    const matches = Object.values(this.acct.orders).filter((o) => o.tag === tag);
    if (matches.length > 1) throw new BrokerError(`Several orders carry tag ${tag}`, false);
    if (!matches[0]) return undefined;
    return this.getOrder(matches[0].orderId);
  }

  async modifyStop(orderId: string, qty: number, trigger: number) {
    this.expireOld();
    const o = this.acct.orders[orderId];
    if (!o || o.type !== 'SL' || o.status !== 'trigger_pending') throw new BrokerError(`Stop ${orderId} cannot be modified (${o?.status ?? 'missing'})`, true);
    if (!Number.isInteger(qty) || qty <= 0 || qty > this.freeQty(o.symbol, orderId)) throw new BrokerError(`Invalid stop quantity ${qty}`, true);
    o.qty = qty;
    o.trigger = toTick(trigger);
    o.limit = stopLimitPrice(trigger, this.opts.stopLimitBufferPct);
    this.save();
  }

  async cancelOrder(orderId: string) {
    this.expireOld();
    const o = this.acct.orders[orderId];
    if (!o) throw new BrokerError(`Unknown order ${orderId}`, true);
    if (TERMINAL.has(o.status)) throw new BrokerError(`Order ${orderId} is already ${o.status}`, true);
    o.status = 'cancelled';
    this.save();
  }
}
