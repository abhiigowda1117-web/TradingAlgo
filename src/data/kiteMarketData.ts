import type { KiteClient } from '../trading/brokers/kiteClient';
import type { Candle } from '../types';
import type { MarketData } from './types';

/** Market data from Kite. Daily candles need the Kite historical-data add-on subscription. */
export class KiteMarketData implements MarketData {
  private tokens = new Map<string, number>();

  constructor(
    private kite: KiteClient,
    private exchange: 'NSE' | 'BSE' = 'NSE',
  ) {}

  async getLtp(symbols: string[]): Promise<Record<string, number>> {
    const data = await this.kite.ltp(symbols.map((s) => `${this.exchange}:${s}`));
    const out: Record<string, number> = {};
    for (const s of symbols) {
      const q = data[`${this.exchange}:${s}`];
      if (q) {
        out[s] = q.last_price;
        this.tokens.set(s, q.instrument_token);
      }
    }
    return out;
  }

  async getDailyCandles(symbol: string, from: Date, to: Date = new Date()): Promise<Candle[]> {
    if (!this.tokens.has(symbol)) await this.getLtp([symbol]);
    const token = this.tokens.get(symbol);
    if (token === undefined) throw new Error(`Unknown instrument ${this.exchange}:${symbol}`);
    return this.kite.historical(token, 'day', from, to);
  }
}
