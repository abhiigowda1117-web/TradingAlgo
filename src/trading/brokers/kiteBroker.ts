import { BrokerError } from './errors';
import { stopLimitPrice, toTick, type Broker, type OrderRequest, type OrderSnapshot, type OrderStatus } from './broker';
import type { KiteClient, KiteOrder } from './kiteClient';

/** Maps Kite's order status strings onto normalised states. Anything unrecognised is 'unknown'. */
export function mapKiteStatus(status: string): OrderStatus {
  switch (status) {
    case 'COMPLETE':
      return 'complete';
    case 'CANCELLED':
      return 'cancelled';
    case 'REJECTED':
      return 'rejected';
    case 'TRIGGER PENDING':
      return 'trigger_pending';
    case 'OPEN':
      return 'open';
    case 'PUT ORDER REQ RECEIVED':
    case 'VALIDATION PENDING':
    case 'OPEN PENDING':
    case 'MODIFY VALIDATION PENDING':
    case 'MODIFY PENDING':
    case 'CANCEL PENDING':
    case 'TRIGGER PENDING VALIDATION':
      return 'pending';
    default:
      return 'unknown';
  }
}

function snapshot(o: KiteOrder): OrderSnapshot {
  return {
    orderId: o.order_id,
    tag: o.tag ?? o.tags?.[0] ?? undefined,
    symbol: o.tradingsymbol,
    side: o.transaction_type,
    status: mapKiteStatus(o.status),
    qty: o.quantity,
    filledQty: o.filled_quantity ?? 0,
    avgPrice: o.average_price ?? 0,
    trigger: o.trigger_price || undefined,
    message: o.status_message ?? undefined,
  };
}

/** Real-money broker backed by Zerodha Kite Connect. Delivery (CNC) product, DAY validity. */
export class KiteBroker implements Broker {
  readonly name = 'kite';

  constructor(
    private kite: KiteClient,
    private opts: { exchange: 'NSE' | 'BSE'; stopLimitBufferPct: number },
  ) {}

  private inst = (s: string) => `${this.opts.exchange}:${s}`;

  async getCash(): Promise<number> {
    const m = await this.kite.margins();
    return m.available.live_balance ?? m.net;
  }

  async getLtp(symbols: string[]): Promise<Record<string, number>> {
    const data = await this.kite.ltp(symbols.map(this.inst));
    return Object.fromEntries(symbols.flatMap((s) => (data[this.inst(s)] ? [[s, data[this.inst(s)]!.last_price]] : [])));
  }

  async getPositionQty(symbol: string): Promise<number> {
    // Settled holdings + T1 (bought yesterday) + today's net CNC position (negative after selling holdings).
    const [holdings, positions] = await Promise.all([this.kite.holdings(), this.kite.positions()]);
    if (!Array.isArray(holdings) || !Array.isArray(positions?.net)) throw new BrokerError('Kite returned malformed holdings/positions', false);
    const h = holdings.find((x) => x.tradingsymbol === symbol);
    const p = positions.net.find((x) => x.tradingsymbol === symbol && x.product === 'CNC');
    return (h?.quantity ?? 0) + (h?.t1_quantity ?? 0) + (p?.quantity ?? 0);
  }

  async submitOrder(req: OrderRequest): Promise<string> {
    if (!/^[A-Za-z0-9]{1,20}$/.test(req.tag)) throw new BrokerError(`Invalid Kite tag "${req.tag}"`, true);
    const base = {
      exchange: this.opts.exchange,
      tradingsymbol: req.symbol,
      transaction_type: req.side,
      quantity: req.qty,
      product: 'CNC',
      validity: 'DAY',
      tag: req.tag,
    };
    if (req.type === 'MARKET') return this.kite.placeOrder({ ...base, order_type: 'MARKET' });
    return this.kite.placeOrder({ ...base, order_type: 'SL', trigger_price: toTick(req.trigger), price: stopLimitPrice(req.trigger, this.opts.stopLimitBufferPct) });
  }

  async getOrder(orderId: string): Promise<OrderSnapshot> {
    const last = (await this.kite.orderHistory(orderId)).at(-1);
    if (!last) throw new BrokerError(`Kite has no history for order ${orderId}`, false);
    return snapshot(last);
  }

  async findOrderByTag(tag: string): Promise<OrderSnapshot | undefined> {
    const matches = (await this.kite.orders()).filter((o) => o.tag === tag || o.tags?.includes(tag));
    if (matches.length > 1) throw new BrokerError(`Several Kite orders carry tag ${tag}; resolve by hand`, false);
    return matches[0] ? snapshot(matches[0]) : undefined;
  }

  async modifyStop(orderId: string, qty: number, trigger: number): Promise<void> {
    await this.kite.modifyOrder(orderId, {
      quantity: qty,
      order_type: 'SL',
      trigger_price: toTick(trigger),
      price: stopLimitPrice(trigger, this.opts.stopLimitBufferPct),
    });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.kite.cancelOrder(orderId);
  }
}
