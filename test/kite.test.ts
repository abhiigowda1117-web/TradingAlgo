import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BrokerError } from '../src/trading/brokers/errors';
import { KiteBroker, mapKiteStatus } from '../src/trading/brokers/kiteBroker';
import { createKiteSession, KiteClient, type Fetch } from '../src/trading/brokers/kiteClient';

// All Kite tests run against a fake fetch: no request ever leaves the process.

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Route = unknown | ((c: Call) => unknown);

/** Fake fetch that records calls and answers from a route table. */
function fakeFetch(routes: Record<string, Route>, opts: { error?: { status: number; error_type: string; message: string } } = {}) {
  const calls: Call[] = [];
  const fn: Fetch = async (input, init) => {
    const c: Call = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body?.toString() };
    calls.push(c);
    if (opts.error) return new Response(JSON.stringify({ status: 'error', error_type: opts.error.error_type, message: opts.error.message }), { status: opts.error.status });
    const key = Object.keys(routes).find((k) => `${c.method} ${c.url}`.includes(k));
    if (!key) return new Response(JSON.stringify({ status: 'error', message: `no route for ${c.method} ${c.url}`, error_type: 'InputException' }), { status: 400 });
    const r = routes[key];
    const data = typeof r === 'function' ? (r as (c: Call) => unknown)(c) : r;
    return new Response(JSON.stringify({ status: 'success', data }), { status: 200 });
  };
  return { fn, calls };
}

const order = (o: Record<string, unknown>) => ({ order_id: '1', tradingsymbol: 'INFY', transaction_type: 'BUY', quantity: 10, filled_quantity: 0, average_price: 0, trigger_price: 0, status: 'OPEN', ...o });

describe('kite client', () => {
  it('creates a session with the sha256 checksum', async () => {
    const { fn, calls } = fakeFetch({ 'POST https://api.kite.trade/session/token': { access_token: 'tok', user_id: 'AB1234' } });
    const s = await createKiteSession('key', 'secret', 'req', fn);
    expect(s.access_token).toBe('tok');
    expect(new URLSearchParams(calls[0]!.body).get('checksum')).toBe(createHash('sha256').update('keyreqsecret').digest('hex'));
  });

  it('sends auth headers', async () => {
    const { fn, calls } = fakeFetch({ '/quote/ltp': { 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } } });
    expect(await new KiteClient('key', 'tok', fn).ltp(['NSE:INFY'])).toEqual({ 'NSE:INFY': { instrument_token: 408065, last_price: 1500 } });
    expect(calls[0]!.url).toBe('https://api.kite.trade/quote/ltp?i=NSE%3AINFY');
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'token key:tok', 'X-Kite-Version': '3' });
  });

  it('times out hung requests and reports the outcome as uncertain', async () => {
    const hang: Fetch = (_u, init) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    const err = await new KiteClient('k', 't', hang, 20).placeOrder({ tradingsymbol: 'INFY' }).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err).toMatchObject({ definite: false, kind: 'timeout' });
  });

  it('classifies definite rejections versus uncertain failures', async () => {
    const reject = await new KiteClient('k', 't', fakeFetch({}, { error: { status: 400, error_type: 'OrderException', message: 'RMS' } }).fn).placeOrder({}).catch((e) => e);
    expect(reject).toMatchObject({ definite: true, kind: 'rejected' });
    const server = await new KiteClient('k', 't', fakeFetch({}, { error: { status: 503, error_type: 'NetworkException', message: 'OMS down' } }).fn).placeOrder({}).catch((e) => e);
    expect(server).toMatchObject({ definite: false, kind: 'server' });
    const auth = await new KiteClient('k', 't', fakeFetch({}, { error: { status: 403, error_type: 'TokenException', message: 'expired' } }).fn).orders().catch((e) => e);
    expect(auth).toMatchObject({ definite: true, kind: 'auth' });
    const net = await new KiteClient('k', 't', async () => { throw new TypeError('fetch failed'); }).orders().catch((e) => e);
    expect(net).toMatchObject({ definite: false, kind: 'network' });
  });

  it('never puts credentials in error messages', async () => {
    const err = await new KiteClient('SECRETKEY', 'SECRETTOKEN', fakeFetch({}, { error: { status: 400, error_type: 'InputException', message: 'bad' } }).fn).orders().catch((e) => e);
    expect(String(err.message)).not.toMatch(/SECRETKEY|SECRETTOKEN/);
  });
});

describe('kite broker', () => {
  const opts = { exchange: 'NSE' as const, stopLimitBufferPct: 0.005 };

  it('maps every Kite status, defaulting to unknown', () => {
    expect(mapKiteStatus('COMPLETE')).toBe('complete');
    expect(mapKiteStatus('TRIGGER PENDING')).toBe('trigger_pending');
    expect(mapKiteStatus('OPEN')).toBe('open');
    expect(mapKiteStatus('VALIDATION PENDING')).toBe('pending');
    expect(mapKiteStatus('SOMETHING NEW')).toBe('unknown');
  });

  it('submits a tagged CNC market order without waiting for a fill', async () => {
    const { fn, calls } = fakeFetch({ 'POST https://api.kite.trade/orders/regular': { order_id: '42' } });
    const id = await new KiteBroker(new KiteClient('k', 't', fn), opts).submitOrder({ tag: 'E2610291abc', symbol: 'INFY', side: 'BUY', qty: 10, type: 'MARKET' });
    expect(id).toBe('42');
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toMatchObject({ tradingsymbol: 'INFY', transaction_type: 'BUY', quantity: '10', product: 'CNC', order_type: 'MARKET', tag: 'E2610291abc' });
  });

  it('places stop-limit sells on valid ticks', async () => {
    const { fn, calls } = fakeFetch({ 'POST https://api.kite.trade/orders/regular': { order_id: '9' } });
    await new KiteBroker(new KiteClient('k', 't', fn), opts).submitOrder({ tag: 'S1', symbol: 'INFY', side: 'SELL', qty: 10, type: 'SL', trigger: 1423.37 });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toMatchObject({ transaction_type: 'SELL', order_type: 'SL', trigger_price: '1423.5', price: '1416.5', product: 'CNC' });
  });

  it('rejects tags Kite would not accept before sending anything', async () => {
    const { fn, calls } = fakeFetch({});
    const err = await new KiteBroker(new KiteClient('k', 't', fn), opts).submitOrder({ tag: 'bad-tag!', symbol: 'INFY', side: 'BUY', qty: 1, type: 'MARKET' }).catch((e) => e);
    expect(err).toMatchObject({ definite: true });
    expect(calls).toHaveLength(0);
  });

  it('reports a partially filled, cancelled market order with its fill', async () => {
    const { fn } = fakeFetch({ 'GET https://api.kite.trade/orders/7': [order({ order_id: '7', status: 'OPEN' }), order({ order_id: '7', status: 'CANCELLED', filled_quantity: 6, average_price: 1501.5 })] });
    expect(await new KiteBroker(new KiteClient('k', 't', fn), opts).getOrder('7')).toMatchObject({ status: 'cancelled', qty: 10, filledQty: 6, avgPrice: 1501.5 });
  });

  it('finds orders by tag and refuses ambiguous matches', async () => {
    const { fn } = fakeFetch({ 'GET https://api.kite.trade/orders': [order({ order_id: '1', tag: 'A1' }), order({ order_id: '2', tags: ['B2'] })] });
    const b = new KiteBroker(new KiteClient('k', 't', fn), opts);
    expect((await b.findOrderByTag('B2'))?.orderId).toBe('2');
    expect(await b.findOrderByTag('C3')).toBeUndefined();
    const dup = fakeFetch({ 'GET https://api.kite.trade/orders': [order({ order_id: '1', tag: 'A1' }), order({ order_id: '2', tag: 'A1' })] });
    await expect(new KiteBroker(new KiteClient('k', 't', dup.fn), opts).findOrderByTag('A1')).rejects.toThrow(/Several/);
  });

  it("counts holdings, T1 and today's CNC position", async () => {
    const { fn } = fakeFetch({
      '/portfolio/holdings': [{ tradingsymbol: 'INFY', quantity: 10, t1_quantity: 5 }],
      '/portfolio/positions': { net: [{ tradingsymbol: 'INFY', product: 'CNC', quantity: -3 }, { tradingsymbol: 'INFY', product: 'MIS', quantity: 100 }] },
    });
    expect(await new KiteBroker(new KiteClient('k', 't', fn), opts).getPositionQty('INFY')).toBe(12);
  });
});
