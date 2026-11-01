import { createServer, type Server } from 'node:http';
import { isValidSymbol, type ResearchReport } from '../research/research';

/**
 * Local research dashboard. Read-only: it serves one page and one JSON endpoint that runs company
 * research. It has no access to the trading engine or any broker.
 */
export interface DashboardDeps {
  research: (symbol: string, peers: string[]) => Promise<ResearchReport>;
  html: string;
  /** Extra static files, e.g. the charting library served from node_modules (no CDN needed). */
  assets?: Record<string, { body: string; type: string }>;
  cacheMinutes?: number;
}

export function createDashboardServer(d: DashboardDeps): Server {
  const cache = new Map<string, { at: number; report: ResearchReport }>();
  const inflight = new Map<string, Promise<ResearchReport>>();
  const ttl = (d.cacheMinutes ?? 15) * 60_000;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: string, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    if (req.method !== 'GET') return send(405, JSON.stringify({ error: 'Method not allowed' }));
    if (url.pathname === '/' || url.pathname === '/index.html') return send(200, d.html, 'text/html; charset=utf-8');
    const asset = d.assets?.[url.pathname];
    if (asset) return send(200, asset.body, asset.type);
    if (url.pathname !== '/api/research') return send(404, JSON.stringify({ error: 'Not found' }));

    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    const peers = (url.searchParams.get('peers') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!isValidSymbol(symbol)) return send(400, JSON.stringify({ error: 'Enter a valid NSE symbol, e.g. RELIANCE or BAJAJ-AUTO' }));
    if (peers.length > 6 || peers.some((p) => !isValidSymbol(p))) return send(400, JSON.stringify({ error: 'Peers must be up to 6 valid NSE symbols, comma separated' }));

    const key = `${symbol}|${peers.join(',')}`;
    const hit = cache.get(key);
    const fresh = url.searchParams.get('refresh') !== '1' && hit && Date.now() - hit.at < ttl;
    if (fresh) return send(200, JSON.stringify({ ...hit.report, cached: true }));
    try {
      let p = inflight.get(key);
      if (!p) {
        p = d.research(symbol, peers);
        inflight.set(key, p);
      }
      const report = await p;
      cache.set(key, { at: Date.now(), report });
      send(200, JSON.stringify(report));
    } catch (e) {
      send(502, JSON.stringify({ error: (e as Error).message }));
    } finally {
      inflight.delete(key);
    }
  });
}
