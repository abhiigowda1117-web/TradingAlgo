import { createHash } from 'node:crypto';
import type { Candle } from '../../types';
import { BrokerError } from './errors';

const BASE = 'https://api.kite.trade';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface KiteOrder {
  order_id: string;
  status: string; // COMPLETE, OPEN, TRIGGER PENDING, CANCELLED, REJECTED, VALIDATION PENDING, ...
  status_message?: string | null;
  tradingsymbol: string;
  transaction_type: 'BUY' | 'SELL';
  quantity: number;
  filled_quantity: number;
  average_price: number;
  trigger_price: number;
  tag?: string | null;
  tags?: string[] | null;
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

/** Kite error types that mean the request was refused outright and nothing was done. */
const DEFINITE_REJECTIONS = new Set(['InputException', 'OrderException', 'PermissionException', 'MarginException', 'TokenException', 'UserException']);

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
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const body = (await res.json()) as { status: string; message?: string; data?: { access_token: string; user_id: string } };
  if (body.status !== 'success' || !body.data) throw new Error(`Kite login failed: ${body.message ?? res.status}`);
  return body.data;
}

/**
 * Minimal Kite Connect v3 REST client covering what the engine needs. Every request has a timeout,
 * and failures are classified into definite rejections versus uncertain outcomes (see BrokerError).
 */
export class KiteClient {
  constructor(
    private apiKey: string,
    private accessToken: string,
    private fetchFn: Fetch = fetch,
    private timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private async call<T>(method: string, path: string, params?: Record<string, string | number>): Promise<T> {
    const form = params ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : undefined;
    const isBody = method === 'POST' || method === 'PUT';
    const url = `${BASE}${path}${!isBody && form ? `?${form}` : ''}`;
    const what = `Kite ${method} ${path.split('?')[0]}`;

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${this.apiKey}:${this.accessToken}`,
          ...(isBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: isBody ? form : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      // The request may have reached Kite before the connection failed: outcome unknown.
      throw new BrokerError(`${what} ${timedOut ? `timed out after ${this.timeoutMs}ms` : `network error: ${(e as Error).message}`}`, false, timedOut ? 'timeout' : 'network');
    }

    let body: { status?: string; message?: string; error_type?: string; data?: T };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new BrokerError(`${what} returned an unreadable response (HTTP ${res.status})`, false, res.status >= 500 ? 'server' : 'unknown');
    }
    if (res.ok && body.status === 'success') return body.data as T;

    const type = body.error_type ?? '';
    const msg = `${what} failed (HTTP ${res.status} ${type}): ${body.message ?? 'no message'}`;
    if (type === 'TokenException') throw new BrokerError(msg, true, 'auth');
    if (res.status === 429) throw new BrokerError(msg, true, 'rejected'); // rate limited before processing
    if (res.status >= 400 && res.status < 500 && DEFINITE_REJECTIONS.has(type)) throw new BrokerError(msg, true, 'rejected');
    throw new BrokerError(msg, false, res.status >= 500 ? 'server' : 'unknown');
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

  /** Today's orders. */
  async orders(): Promise<KiteOrder[]> {
    return this.call('GET', '/orders');
  }

  async orderHistory(orderId: string): Promise<KiteOrder[]> {
    return this.call('GET', `/orders/${encodeURIComponent(orderId)}`);
  }

  async placeOrder(params: Record<string, string | number>): Promise<string> {
    const data = await this.call<{ order_id: string }>('POST', '/orders/regular', params);
    return data.order_id;
  }

  async modifyOrder(orderId: string, params: Record<string, string | number>): Promise<void> {
    await this.call('PUT', `/orders/regular/${encodeURIComponent(orderId)}`, params);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.call('DELETE', `/orders/regular/${encodeURIComponent(orderId)}`);
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
