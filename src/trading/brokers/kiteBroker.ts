import type { Side } from '../../types';
import { sleep } from '../../util/time';
import { toTick, type Broker, type Fill, type StopOrderStatus } from './broker';
import type { KiteClient, KiteOrder } from './kiteClient';

/** Real-money broker backed by Zerodha Kite Connect. Delivery (CNC) product, DAY validity. */
export class KiteBroker implements Broker {
  readonly name = 'kite';

  constructor(
    private kite: KiteClient,
    private opts: { exchange: 'NSE' | 'BSE'; stopLimitBufferPct: number; fillTimeoutMs?: number; pollMs?: number },
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
    const h = holdings.find((x) => x.tradingsymbol === symbol);
    const p = positions.net.find((x) => x.tradingsymbol === symbol && x.product === 'CNC');
    return (h?.quantity ?? 0) + (h?.t1_quantity ?? 0) + (p?.quantity ?? 0);
  }

  async marketOrder(symbol: string, side: Side, qty: number): Promise<Fill> {
    const orderId = await this.kite.placeOrder({
      exchange: this.opts.exchange,
      tradingsymbol: symbol,
      transaction_type: side,
      quantity: qty,
      product: 'CNC',
      order_type: 'MARKET',
      validity: 'DAY',
      tag: 'algo',
    });
    const o = await this.waitFor(orderId, ['COMPLETE', 'REJECTED', 'CANCELLED']);
    if (o.status !== 'COMPLETE') throw new Error(`${side} ${qty} ${symbol} ${o.status}: ${o.status_message ?? ''}`);
    return { orderId, qty: o.filled_quantity, avgPrice: o.average_price };
  }

  private stopParams(trigger: number) {
    const t = toTick(trigger);
    // SL (stop-limit) sell: triggers at `t`, then sells with a limit a little below it.
    return { trigger_price: t, price: toTick(t * (1 - this.opts.stopLimitBufferPct)) };
  }

  async placeStop(symbol: string, qty: number, trigger: number): Promise<string> {
    return this.kite.placeOrder({
      exchange: this.opts.exchange,
      tradingsymbol: symbol,
      transaction_type: 'SELL',
      quantity: qty,
      product: 'CNC',
      order_type: 'SL',
      validity: 'DAY',
      tag: 'algo-stop',
      ...this.stopParams(trigger),
    });
  }

  async modifyStop(orderId: string, _symbol: string, qty: number, trigger: number): Promise<void> {
    await this.kite.modifyOrder(orderId, { quantity: qty, order_type: 'SL', ...this.stopParams(trigger) });
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.kite.cancelOrder(orderId);
  }

  async getStopStatus(orderId: string): Promise<StopOrderStatus> {
    const o = (await this.kite.orderHistory(orderId)).at(-1);
    if (!o) return { status: 'cancelled' };
    if (o.status === 'COMPLETE') return { status: 'filled', avgPrice: o.average_price };
    if (o.status === 'CANCELLED') return { status: 'cancelled' };
    if (o.status === 'REJECTED') return { status: 'rejected' };
    return { status: 'pending' };
  }

  private async waitFor(orderId: string, terminal: string[]): Promise<KiteOrder> {
    const deadline = Date.now() + (this.opts.fillTimeoutMs ?? 30_000);
    for (;;) {
      const o = (await this.kite.orderHistory(orderId)).at(-1);
      if (o && terminal.includes(o.status)) return o;
      if (Date.now() > deadline) throw new Error(`Order ${orderId} not complete after timeout (last status ${o?.status ?? 'unknown'})`);
      await sleep(this.opts.pollMs ?? 1000);
    }
  }
}
