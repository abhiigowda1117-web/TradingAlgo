import 'dotenv/config';
import { resolve } from 'node:path';
import { ROOT } from '../config';

/** Web server settings from environment variables. Secrets never leave the server. */
export interface ServerConfig {
  databaseUrl: string;
  host: string;
  port: number;
  /** Origins allowed to call the API from a browser (CORS). */
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  sessionTtlMs: number;
  staticDir: string;
  production: boolean;
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|yes)$/i.test(v));

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const errors: string[] = [];
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) errors.push('DATABASE_URL must be set, e.g. postgres://postgres:yourpassword@localhost:5432/algotrade');
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`PORT must be a port number, got "${env.PORT}"`);
  const ttlHours = Number(env.SESSION_TTL_HOURS ?? 12);
  if (!(ttlHours > 0 && ttlHours <= 168)) errors.push('SESSION_TTL_HOURS must be between 1 and 168');
  const allowedOrigins = (env.APP_ORIGIN ?? `http://localhost:5173,http://localhost:${port}`)
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  for (const o of allowedOrigins) if (!/^https?:\/\/[^/\s]+$/.test(o)) errors.push(`APP_ORIGIN entry "${o}" must look like https://example.com`);
  const production = env.NODE_ENV === 'production';
  const cookieSecure = bool(env.COOKIE_SECURE, production);
  if (production && !cookieSecure) errors.push('COOKIE_SECURE must be true in production (serve the site over HTTPS)');
  if (errors.length) throw new Error(`Invalid server configuration:\n  - ${errors.join('\n  - ')}`);
  return {
    databaseUrl,
    host: env.HOST ?? '127.0.0.1',
    port,
    allowedOrigins,
    cookieSecure,
    trustProxy: bool(env.TRUST_PROXY, false),
    sessionTtlMs: ttlHours * 3_600_000,
    staticDir: resolve(ROOT, env.STATIC_DIR ?? 'web/dist'),
    production,
  };
}
