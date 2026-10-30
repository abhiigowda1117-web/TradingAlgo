import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KiteBroker } from '../src/trading/brokers/kiteBroker';
import { createKiteSession, KiteClient, type Fetch } from '../src/trading/brokers/kiteClient';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Fake fetch that records calls and answers from a route table. */
function fakeFetch(routes: Record<string, unknown | ((c: Call) => unknown)>) {
  const calls: Call[] = [];
  const fn: Fetch = async (input, init) => {
    const c: Call = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body?.toString() };
    calls.push(c);
    const key = Object.keys(routes).find((k) => `${c.method} ${c.url}`.includes(k));
    if (!key) return new Response(JSON.stringify({ status: 'error', message: `no route for ${c.method} ${c.url}`, error_type: 'InputException' }), { status: 400 });
    const r = routes[key];
    const data = typeof r === 'function' ? r(c) : r;
    return new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
  };
  return { fn, calls };
}

describe('kite client', () => {
  it('creates a session with the sha256 checksum', async () => {
    const { fn, calls } = fakeFetch({ 'POST https://api.kite.trade/session/token': { access_token: 'tok', user_id: 'AB1234' } });
    const s = await createKiteSession('key', 'secret', 'req', fn);
    expect(s.access_token).toBe('tok');
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get('checksum')).toBe(createHash('sha256').update('keyreqsecret').digest('hex'));
  });

  it('sends auth headers and surfaces Kite errors', async () => {
    const { fn, calls } = fakeFetch({ '/quote/ltp': { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } } });
    const k = new KiteClient('key', 'tok', fn);
    expect(await k.ltp(['NSE:INFY'])).toEqual({ 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } });
    expect(calls[0]!.url).toBe('https://api.kite.trade/quote/ltp?i=NSE%3AINFY');
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'token key:tok', 'X-Kite-Version': '3' });
    await expect(k.orders()).rejects.toThrow(/InputException/);
  });
});

describe('kite broker', () => {
  const opts = { exchange: 'NSE' as const, stopLimitBufferPct: 0.005, pollMs: 1 };

  it('places a CNC market order and waits for completion', async () => {
    let polls = 0;
    const { fn, calls } = fakeFetch({
      'POST https://api.kite.trade/orders/regular': { order_id: '42' },
      'GET https://api.kite.trade/orders/42': () =>
        ++polls < 2 ? [{ status: 'OPEN' }] : [{ status: 'OPEN' }, { status: 'COMPLETE', filled_quantity: 10, average_price: 1501.5 }],
    });
    const b = new KiteBroker(new KiteClient('k', 't', fn), opts);
    expect(await b.marketOrder('INFY', 'BUY', 10)).toEqual({ orderId: '42', qty: 10, avgPrice: 1501.5 });
    const body = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(body)).toMatchObject({ exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'BUY', quantity: '10', product: 'CNC', order_type: 'MARKET' });
  });

  it('throws when an order is rejected', async () => {
    const { fn } = fakeFetch({
      'POST https://api.kite.trade/orders/regular': { order_id: '7' },
      'GET https://api.kite.trade/orders/7': [{ status: 'REJECTED', status_message: 'Insufficient funds' }],
    });
    await expect(new KiteBroker(new KiteClient('k', 't', fn), opts).marketOrder('INFY', 'BUY', 1)).rejects.toThrow(/REJECTED: Insufficient funds/);
  });

  it('places stop-limit sells on valid ticks', async () => {
    const { fn, calls } = fakeFetch({ 'POST https://api.kite.trade/orders/regular': { order_id: '9' } });
    await new KiteBroker(new KiteClient('k', 't', fn), opts).placeStop('INFY', 10, 1423.37);
    const body = Object.fromEntries(new URLSearchParams(calls[0]!.body));
    expect(body).toMatchObject({ transaction_type: 'SELL', order_type: 'SL', trigger_price: '1423.5', price: '1416.5', product: 'CNC' });
  });

  it('counts holdings, T1 and today\'s CNC position', async () => {
    const { fn } = fakeFetch({
      '/portfolio/holdings': [{ tradingsymbol: 'INFY', quantity: 10, t1_quantity: 5 }],
      '/portfolio/positions': { net: [{ tradingsymbol: 'INFY', product: 'CNC', quantity: -3 }, { tradingsymbol: 'INFY', product: 'MIS', quantity: 100 }] },
    });
    expect(await new KiteBroker(new KiteClient('k', 't', fn), opts).getPositionQty('INFY')).toBe(12);
  });
});
