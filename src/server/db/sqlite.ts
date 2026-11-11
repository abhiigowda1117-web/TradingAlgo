import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type pg from 'pg';
import type { Db } from './pool';
import type { MigrationTarget } from './migrate';

/**
 * Zero-install database: a single SQLite file (data/algotrade.db) through Node's built-in node:sqlite,
 * so the website needs no database server. Speaks the same small SQL dialect the repositories use:
 * $1-style parameters and now() are translated; booleans and dates are stored as 1/0 and ISO strings.
 */

type SqliteModule = typeof import('node:sqlite');
type SqliteDatabase = InstanceType<SqliteModule['DatabaseSync']>;

/** Loads node:sqlite without its "experimental feature" warning on every start. */
function loadSqlite(): SqliteModule {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(typeof warning === 'string' ? warning : warning.message).includes('SQLite')) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
}

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
/** Postgres-flavoured SQL -> SQLite: $1 -> ?1 and now() -> an ISO timestamp. */
export const toSqlite = (sql: string) => sql.replace(/\$(\d+)/g, '?$1').replace(/\bnow\(\)/gi, NOW);
const bind = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v);
const returnsRows = (sql: string) => /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);

export class SqliteDb implements MigrationTarget {
  readonly kind = 'sqlite';
  private db: SqliteDatabase;
  private depth = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<pg.QueryResult<R>> {
    const sql = toSqlite(text);
    if (values.length === 0 && !returnsRows(sql)) {
      this.db.exec(sql); // may hold several statements (migration files)
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as pg.QueryResult<R>;
    }
    const stmt = this.db.prepare(sql);
    const params = values.map(bind) as (string | number | bigint | null | Uint8Array)[];
    if (returnsRows(sql)) {
      const rows = stmt.all(...params) as R[];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as unknown as pg.QueryResult<R>;
    }
    const r = stmt.run(...params);
    return { rows: [], rowCount: Number(r.changes), command: '', oid: 0, fields: [] } as unknown as pg.QueryResult<R>;
  }

  async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this);
    this.db.exec('BEGIN');
    this.depth++;
    try {
      const out = await fn(this);
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.db.close();
  }
}
