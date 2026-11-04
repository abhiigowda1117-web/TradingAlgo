import pg from 'pg';

/** The minimal query interface the repositories need; satisfied by pg.Pool, pg.Client and pg-mem. */
export interface Db {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  // An idle client error must not crash the server; the next query reconnects.
  pool.on('error', (e) => console.error(`PostgreSQL pool error: ${e.message}`));
  return pool;
}

/**
 * Plain-language reason for a database connection failure. Node reports "connection refused" on both
 * IPv4 and IPv6 as an AggregateError with an empty message, which used to print as a blank reason.
 */
export function explainDbError(e: unknown): string {
  const err = e as { message?: string; code?: string; errors?: { code?: string; message?: string }[] };
  const codes = [err.code, ...(err.errors ?? []).map((x) => x.code)].filter(Boolean);
  const msg = err.message || (err.errors ?? []).map((x) => x.message).filter(Boolean).join('; ');
  if (codes.includes('ECONNREFUSED')) return 'PostgreSQL is not running (connection refused on the DATABASE_URL host and port). Start the PostgreSQL service, or reinstall PostgreSQL if it was removed.';
  if (codes.includes('ENOTFOUND')) return `The database host in DATABASE_URL was not found (${msg}).`;
  if (codes.includes('28P01') || /password authentication failed/i.test(msg)) return 'Wrong PostgreSQL password in DATABASE_URL. Write any @ in the password as %40.';
  if (codes.includes('3D000') || /database .* does not exist/i.test(msg)) return 'The "algotrade" database does not exist yet. Create it with: psql -U postgres -c "CREATE DATABASE algotrade;"';
  return msg || String(e);
}
