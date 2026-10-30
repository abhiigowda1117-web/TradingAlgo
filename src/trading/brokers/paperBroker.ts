import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MarketData } from '../../data/types';
import type { Side } from '../../types';
import { toTick, type Broker, type Fill, type StopOrderStatus } from './broker';

interface PaperStop {
  symbol: string;
  qty: number;
  trigger: number;
  status: StopOrderStatus['status'];
  avgPrice?: number;
}

interface PaperAccount {
  cash: number;
  positions: Record<string, number>;
  stops: Record<string, PaperStop>;
  nextId: number;
}

/**
 * Simulated broker: fills market orders at the current LTP (plus costs) and triggers stops
 * when a polled LTP is at or below the trigger. State persists to a JSON file between runs.
 */
export class PaperBroker implements Broker {
  readonly name = 'paper';
  private acct: PaperAccount;

  constructor(
    private data: MarketData,
    private opts: { file?: string; initialCash: number; costPct: number },
  ) {
    this.acct =
      opts.file && existsSync(opts.file)
        ? (JSON.parse(readFileSync(opts.file, 'utf8')) as PaperAccount)
        : { cash: opts.initialCash, positions: {}, stops: {}, nextId: 1 };
  }

  private save() {
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    writeFileSync(this.opts.file, JSON.stringify(this.acct, null, 2));
  }

  private id = () => `paper-${this.acct.nextId++}`;

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
    if (p === undefined) throw new Error(`No price for ${symbol}`);
    return p;
  }

  async marketOrder(symbol: string, side: Side, qty: number): Promise<Fill> {
    const price = await this.price(symbol);
    const value = price * qty;
    const cost = value * this.opts.costPct;
    const held = this.acct.positions[symbol] ?? 0;
    if (side === 'BUY') {
      if (value + cost > this.acct.cash) throw new Error(`Insufficient paper cash for ${qty} ${symbol}`);
      this.acct.cash -= value + cost;
      this.acct.positions[symbol] = held + qty;
    } else {
      if (qty > held) throw new Error(`Cannot sell ${qty} ${symbol}, holding ${held}`);
      this.acct.cash += value - cost;
      this.acct.positions[symbol] = held - qty;
    }
    const orderId = this.id();
    this.save();
    return { orderId, qty, avgPrice: price };
  }

  async placeStop(symbol: string, qty: number, trigger: number) {
    const id = this.id();
    this.acct.stops[id] = { symbol, qty, trigger: toTick(trigger), status: 'pending' };
    this.save();
    return id;
  }

  async modifyStop(orderId: string, _symbol: string, qty: number, trigger: number) {
    const s = this.acct.stops[orderId];
    if (!s || s.status !== 'pending') throw new Error(`Stop ${orderId} is not pending`);
    s.qty = qty;
    s.trigger = toTick(trigger);
    this.save();
  }

  async cancelOrder(orderId: string) {
    const s = this.acct.stops[orderId];
    if (s?.status === 'pending') s.status = 'cancelled';
    this.save();
  }

  async getStopStatus(orderId: string): Promise<StopOrderStatus> {
    const s = this.acct.stops[orderId];
    if (!s) return { status: 'cancelled' };
    if (s.status === 'pending') {
      const price = await this.price(s.symbol);
      if (price <= s.trigger) {
        const qty = Math.min(s.qty, this.acct.positions[s.symbol] ?? 0);
        this.acct.cash += qty * price * (1 - this.opts.costPct);
        this.acct.positions[s.symbol] = (this.acct.positions[s.symbol] ?? 0) - qty;
        s.status = 'filled';
        s.avgPrice = price;
        this.save();
      }
    }
    return { status: s.status, avgPrice: s.avgPrice };
  }
}
