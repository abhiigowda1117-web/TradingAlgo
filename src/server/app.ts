import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { hashPassword, parseCookies, safeEqual, verifyPassword } from './auth/password';
import { RateLimiter } from './auth/rateLimit';
import type { Db } from './db/pool';
import type { SessionRecord, SessionRepo, SystemLogRepo, UserRepo } from './db/repositories';

/**
 * AlgoTrade REST API and static site. Security layers, in order: security headers on every response,
 * CORS restricted to the app origin, per-address rate limiting, JSON-only bodies with size limits,
 * session cookie authentication on every private route, and a CSRF token on state-changing requests.
 * The API is read-only towards trading: it never imports broker or engine execution code.
 */

export interface ApiRoutes {
  /** Protected GET handlers, keyed by path. They receive the query string and return JSON. */
  [path: string]: (q: URLSearchParams, session: SessionRecord) => Promise<unknown> | unknown;
}

/**
 * State-changing POST handlers (engine controls, paper orders, jobs), keyed by path. They run only for a
 * signed-in session with a valid CSRF token and an account that is allowed to control (not view-only).
 */
export interface ApiActions {
  [path: string]: (body: Record<string, unknown>, session: SessionRecord) => Promise<unknown> | unknown;
}

export interface AppDeps {
  db: Db;
  users: UserRepo;
  sessions: SessionRepo;
  logs: SystemLogRepo;
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  sessionTtlMs: number;
  tradingMode: 'paper' | 'live';
  version: string;
  routes: ApiRoutes;
  actions?: ApiActions;
  /** Built frontend (web/dist). Optional: in development Vite serves the frontend. */
  staticDir?: string;
  apiLimit?: { max: number; windowMs: number };
  loginLimit?: { max: number; windowMs: number };
}

export const COOKIE = 'algotrade_sid';

const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/i.test(h);
const hostname = (host: string) => (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!).toLowerCase();

/**
 * A page served by this server may call its own API without being listed in APP_ORIGIN, so the phone,
 * Tailscale and other computers work with no settings. To stop DNS rebinding (a hostile site renaming
 * itself to this server), that only applies when the address is an IP, localhost, a Tailscale name, or
 * a host already listed in APP_ORIGIN.
 */
export function sameOriginAllowed(origin: string, host: string | undefined, allowed: string[]): boolean {
  if (!host) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.host.toLowerCase() !== host.toLowerCase()) return false;
  const name = hostname(host);
  const listed = allowed.some((a) => {
    try {
      return new URL(a).hostname.toLowerCase() === name;
    } catch {
      return false;
    }
  });
  return listed || name === 'localhost' || isIpLiteral(name) || name.endsWith('.ts.net');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** First-run account creation is only offered to the person at the computer running the site. */
const atThisComputer = (req: IncomingMessage) =>
  LOOPBACK.has(req.socket.remoteAddress ?? '') && ['localhost', '127.0.0.1', '[::1]'].includes(hostname(String(req.headers.host ?? '')));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON (Content-Type: application/json)');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function createApp(d: AppDeps): Server {
  const apiLimiter = new RateLimiter(d.apiLimit?.max ?? 300, d.apiLimit?.windowMs ?? 5 * 60_000);
  const loginLimiter = new RateLimiter(d.loginLimit?.max ?? 5, d.loginLimit?.windowMs ?? 15 * 60_000);
  // Verifying against a dummy hash when the user does not exist keeps response times uniform.
  const dummyHash = hashPassword('not-a-real-password-' + Math.random());

  const baseHeaders = (type: string): Record<string, string> => ({
    'Content-Type': type,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(d.cookieSecure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  });
  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...baseHeaders('application/json; charset=utf-8'), 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  const cookie = (value: string, maxAgeSec: number) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${d.cookieSecure ? '; Secure' : ''}`;
  const clientIp = (req: IncomingMessage) => {
    const fwd = d.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : '';
    return fwd || req.socket.remoteAddress || 'unknown';
  };
  const requireCsrf = (req: IncomingMessage, s: SessionRecord) => {
    const token = String(req.headers['x-csrf-token'] ?? '');
    if (!token || !safeEqual(token, s.csrfToken)) throw new HttpError(403, 'Missing or invalid CSRF token');
  };

  async function login(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req);
    if (loginLimiter.limited(ip)) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || username.length > 32 || !password || password.length > 200) throw new HttpError(400, 'Enter a username and password');
    const user = await d.users.findByUsername(username);
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await dummyHash), false);
    if (!user || !ok) {
      loginLimiter.hit(ip);
      await d.logs.write('warn', 'auth', 'Failed sign-in', { username, ip }).catch(() => undefined);
      throw new HttpError(401, 'Wrong username or password');
    }
    loginLimiter.reset(ip);
    const s = await d.sessions.create(user.id, { ip, userAgent: String(req.headers['user-agent'] ?? '') });
    await d.users.touchLogin(user.id);
    await d.logs.write('info', 'auth', 'Signed in', { username, ip }).catch(() => undefined);
    send(res, 200, { user: { username: user.username }, csrfToken: s.csrfToken }, { 'Set-Cookie': cookie(s.id, Math.floor(d.sessionTtlMs / 1000)) });
  }

  /** Creates the very first account (full control) and signs it in. Only with no accounts, only at this computer. */
  async function firstAccount(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req);
    if (loginLimiter.limited(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (!atThisComputer(req)) throw new HttpError(403, 'Create the first account on the computer that runs AlgoTrade, at http://localhost:3001.');
    if ((await d.users.count()) > 0) throw new HttpError(409, 'An account already exists. Sign in instead.');
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, 'Username: 3 to 32 characters, lowercase letters, digits, _ . -');
    if (password.length < 10 || password.length > 200) throw new HttpError(400, 'Password: at least 10 characters');
    await d.users.upsertOwner(username, await hashPassword(password));
    loginLimiter.hit(ip); // counts toward the limit, so this cannot be hammered
    const user = (await d.users.findByUsername(username))!;
    const s = await d.sessions.create(user.id, { ip, userAgent: String(req.headers['user-agent'] ?? '') });
    await d.users.touchLogin(user.id);
    await d.logs.write('info', 'auth', 'First account created', { username, ip }).catch(() => undefined);
    send(res, 200, { user: { username: user.username }, csrfToken: s.csrfToken }, { 'Set-Cookie': cookie(s.id, Math.floor(d.sessionTtlMs / 1000)) });
  }

  async function health(res: ServerResponse) {
    let database: 'ok' | 'unavailable' = 'ok';
    try {
      await Promise.race([d.db.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    } catch {
      database = 'unavailable';
    }
    send(res, database === 'ok' ? 200 : 503, { status: database === 'ok' ? 'ok' : 'degraded', database, tradingMode: d.tradingMode, version: d.version, time: new Date().toISOString() });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const root = d.staticDir;
    if (!root || !existsSync(join(root, 'index.html'))) {
      res.writeHead(404, { ...baseHeaders('text/plain; charset=utf-8') });
      return res.end('Frontend not built. For development run "npm run web:dev"; to build it run "npm run web:build".');
    }
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    const file = join(root, rel);
    const inside = file === root || file.startsWith(root + sep);
    const target = inside && rel && existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html'); // SPA fallback
    const isIndex = target.endsWith(`${sep}index.html`);
    res.writeHead(200, {
      ...baseHeaders(MIME[extname(target)] ?? 'application/octet-stream'),
      'Cache-Control': isIndex ? 'no-store' : rel.startsWith('assets') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(target));
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return serveStatic(req, res, path);
      }

      // CORS: only the app's own origin(s) may call the API from a browser.
      const origin = req.headers.origin;
      const cors: Record<string, string> = {};
      if (origin) {
        if (!d.allowedOrigins.includes(origin) && !sameOriginAllowed(origin, req.headers.host, d.allowedOrigins)) throw new HttpError(403, 'Origin not allowed');
        Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...baseHeaders('text/plain'), ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

      if (!apiLimiter.take(clientIp(req))) throw new HttpError(429, 'Too many requests; slow down');

      if (path === '/api/health' && req.method === 'GET') return await health(res);
      if (path === '/api/auth/login' && req.method === 'POST') return await login(req, res);
      if (path === '/api/setup' && req.method === 'GET') {
        const needsAccount = (await d.users.count()) === 0;
        return send(res, 200, { needsAccount, canCreateHere: needsAccount && atThisComputer(req) });
      }
      if (path === '/api/setup/account' && req.method === 'POST') return await firstAccount(req, res);

      const sid = parseCookies(req.headers.cookie)[COOKIE];
      const session = await d.sessions.get(sid);
      if (path === '/api/auth/logout' && req.method === 'POST') {
        if (session) requireCsrf(req, session);
        await d.sessions.destroy(sid);
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      }
      if (!session) throw new HttpError(401, 'Please sign in');
      if (path === '/api/auth/me' && req.method === 'GET') return send(res, 200, { user: { username: session.username, canControl: session.canControl !== false }, csrfToken: session.csrfToken, tradingMode: d.tradingMode });

      const action = req.method === 'POST' ? d.actions?.[path] : undefined;
      if (action) {
        requireCsrf(req, session);
        if (session.canControl === false) throw new HttpError(403, 'This account is view-only. Only the owner can control the engine or place paper orders.');
        const body = await readJson(req);
        const result = await action(body, session);
        await d.logs.write('info', 'control', `${path} by ${session.username}`, { body }).catch(() => undefined);
        return send(res, 200, result);
      }

      const handler = req.method === 'GET' ? d.routes[path] : undefined;
      if (!handler) {
        if (req.method !== 'GET') requireCsrf(req, session); // state-changing routes (Phase 2) need CSRF
        throw new HttpError(404, 'Not found');
      }
      return send(res, 200, await handler(url.searchParams, session));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`API error on ${req.method} ${path}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error; see the server log' : (e as Error).message });
      else res.end();
    }
  });
}
