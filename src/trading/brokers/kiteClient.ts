import { createHash } from 'node:crypto';
import type { Candle } from '../../types';

const BASE = 'https://api.kite.trade';

export interface KiteOrder {
  order_id: string;
  status: string; // COMPLETE, OPEN, TRIGGER PENDING, CANCELLED, REJECTED, ...
  status_message?: string | null;
  tradingsymbol: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  filled_quantity: number;
  average_price: number;
  trigger_price: number;
}

interface KiteHolding {
  tradingsymbol: string;
  quantity: number;
  t1_quantity: number;
}

interface KitePosition {
  tradingsymbol: string;
  product: string;
  quantity: number;
}

export type Fetch = typeof fetch;

export function kiteLoginUrl(apiKey: string): string {
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
}

/** Exchanges the request_token from the login redirect for the day's access token. */
export async function createKiteSession(apiKey: string, apiSecret: string, requestToken: string, fetchFn: Fetch = fetch) {
  const checksum = createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');
  const res = await fetchFn(`${BASE}/session/token`, {
    method: 'POST',
    headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
  });
  const body = (await res.json()) as { status: string; message?: string; data?: { access_token: string; user_id: string } };
  if (body.status !== 'success' || !body.data) throw new Error(`Kite login failed: ${body.message ?? res.status}`);
  return body.data;
}

/** Minimal Kite Connect v3 REST client covering what the engine needs. */
export class KiteClient {
  constructor(
    private apiKey: string,
    private accessToken: string,
    private fetchFn: Fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, params?: Record<string, string | number>): Promise<T> {
    const form = params ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : undefined;
    const isBody = method === 'POST' || method === 'PUT';
    const url = `${BASE}${path}${!isBody && form ? `?${form}` : ''}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${this.apiKey}:${this.accessToken}`,
        ...(isBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: isBody ? form : undefined,
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string; error_type?: string; data?: T };
    if (!res.ok || body.status !== 'success') {
      throw new Error(`Kite ${method} ${path} failed (${res.status} ${body.error_type ?? ''}): ${body.message ?? 'no message'}`);
    }
    return body.data as T;
  }

  async ltp(instruments: string[]): Promise<Record<string, { instrument_token: number; last_price: number }>> {
    if (instruments.length === 0) return {};
    const qs = instruments.map((i) => `i=${encodeURIComponent(i)}`).join('&');
    return this.call('GET', `/quote/ltp?${qs}`);
  }

  async margins(): Promise<{ net: number; available: { live_balance: number; cash: number } }> {
    return this.call('GET', '/user/margins/equity');
  }

  async holdings(): Promise<KiteHolding[]> {
    return this.call('GET', '/portfolio/holdings');
  }

  async positions(): Promise<{ net: KitePosition[] }> {
    return this.call('GET', '/portfolio/positions');
  }

  async orders(): Promise<KiteOrder[]> {
    return this.call('GET', '/orders');
  }

  async orderHistory(orderId: string): Promise<KiteOrder[]> {
    return this.call('GET', `/orders/${orderId}`);
  }

  async placeOrder(params: Record<string, string | number>): Promise<string> {
    const data = await this.call<{ order_id: string }>('POST', '/orders/regular', params);
    return data.order_id;
  }

  async modifyOrder(orderId: string, params: Record<string, string | number>): Promise<void> {
    await this.call('PUT', `/orders/regular/${orderId}`, params);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.call('DELETE', `/orders/regular/${orderId}`);
  }

  /** Requires the Kite historical-data add-on. */
  async historical(instrumentToken: number, interval: string, from: Date, to: Date): Promise<Candle[]> {
    const fmt = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
    const data = await this.call<{ candles: [string, number, number, number, number, number][] }>(
      'GET',
      `/instruments/historical/${instrumentToken}/${interval}`,
      { from: fmt(from), to: fmt(to) },
    );
    return data.candles.map(([t, open, high, low, close, volume]) => ({ time: new Date(t), open, high, low, close, volume }));
  }
}
