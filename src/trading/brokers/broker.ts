import type { Side } from '../../types';

/**
 * Normalised order states.
 * - pending: accepted but still being validated (not yet live at the exchange)
 * - open: live and working; for a stop-limit this means it has TRIGGERED and its limit is waiting to fill
 * - trigger_pending: stop order live at the exchange, not yet triggered (the only state that counts as protection)
 * - complete / cancelled / rejected: terminal; cancelled and rejected may still carry a partial fill
 * - unknown: anything the adapter does not recognise. Never treated as filled, cancelled or protected.
 */
export type OrderStatus = 'pending' | 'open' | 'trigger_pending' | 'complete' | 'cancelled' | 'rejected' | 'unknown';

export const TERMINAL: ReadonlySet<OrderStatus> = new Set(['complete', 'cancelled', 'rejected']);

export interface OrderSnapshot {
  orderId: string;
  tag?: string;
  symbol: string;
  side: Side;
  status: OrderStatus;
  qty: number;
  filledQty: number;
  /** Average fill price of filledQty (0 when nothing filled). */
  avgPrice: number;
  trigger?: number;
  message?: string;
}

export type OrderRequest =
  | { tag: string; symbol: string; side: Side; qty: number; type: 'MARKET' }
  | { tag: string; symbol: string; side: 'SELL'; qty: number; type: 'SL'; trigger: number };

/**
 * What the engine needs from a broker. Symbols are exchange tradingsymbols ("INFY").
 *
 * Every method may throw BrokerError. A non-definite error from submitOrder means the order MAY
 * exist; callers reconcile with findOrderByTag before doing anything else.
 */
export interface Broker {
  readonly name: string;
  getCash(): Promise<number>;
  getLtp(symbols: string[]): Promise<Record<string, number>>;
  /** Net long quantity held, including holdings bought on earlier days. */
  getPositionQty(symbol: string): Promise<number>;
  /** Submits without waiting for a fill. Returns the broker order id. `tag` must be unique per order. */
  submitOrder(req: OrderRequest): Promise<string>;
  getOrder(orderId: string): Promise<OrderSnapshot>;
  /** Looks an order up by its unique tag among today's orders. Undefined means the broker has no such order (yet). */
  findOrderByTag(tag: string): Promise<OrderSnapshot | undefined>;
  modifyStop(orderId: string, qty: number, trigger: number): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
}

/**
 * Rounds a price to a tick that is valid on NSE equities. NSE's tick size grows with price,
 * so this rounds to a deliberately coarse multiple (a multiple of the coarser tick is always
 * a multiple of the finer one). The cost is at most a few paise of stop precision.
 */
export function toTick(price: number): number {
  const tick = price < 250 ? 0.05 : price < 1000 ? 0.1 : price < 5000 ? 0.5 : price < 10000 ? 1 : 5;
  return Math.round(Math.round(price / tick) * tick * 100) / 100;
}

/** Stop-limit sell price: a little below the trigger so it fills on a normal move through the stop. */
export const stopLimitPrice = (trigger: number, bufferPct: number) => toTick(toTick(trigger) * (1 - bufferPct));
