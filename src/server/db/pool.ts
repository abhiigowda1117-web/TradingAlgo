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
