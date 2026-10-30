import type { Side } from '../../types';

export interface Fill {
  orderId: string;
  qty: number;
  avgPrice: number;
}

export interface StopOrderStatus {
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  avgPrice?: number;
}

/**
 * What the engine needs from a broker. Symbols are exchange tradingsymbols ("INFY").
 * Stop orders are DAY orders on Kite, so the engine re-arms them each trading day.
 */
export interface Broker {
  readonly name: string;
  getCash(): Promise<number>;
  getLtp(symbols: string[]): Promise<Record<string, number>>;
  /** Net long quantity held, including holdings bought on earlier days. */
  getPositionQty(symbol: string): Promise<number>;
  /** Places a market order and waits for it to complete. Throws if it is rejected or does not fill. */
  marketOrder(symbol: string, side: Side, qty: number): Promise<Fill>;
  placeStop(symbol: string, qty: number, trigger: number): Promise<string>;
  modifyStop(orderId: string, symbol: string, qty: number, trigger: number): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  getStopStatus(orderId: string): Promise<StopOrderStatus>;
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
