import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './pool';

/** Something that can run a set of statements atomically (a pg.Pool via a client, or a test database). */
export interface MigrationTarget extends Db {
  transaction?<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

/**
 * Applies db/migrations/NNN_name.sql files in order, each once, recording them in
 * schema_migrations. Returns the versions applied in this run.
 */
export async function migrate(db: MigrationTarget, dir: string): Promise<string[]> {
  let rows: { version: string }[];
  try {
    rows = (await db.query<{ version: string }>('SELECT version FROM schema_migrations')).rows;
  } catch {
    // First run: the tracking table does not exist yet.
    await db.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    rows = [];
  }
  const done = new Set(rows.map((r) => r.version));
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    const run = async (t: Db) => {
      await t.query(sql);
      await t.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    };
    if (db.transaction) await db.transaction(run);
    else await run(db);
    applied.push(version);
  }
  return applied;
}

/** Wraps a pg.Pool so each migration runs inside BEGIN/COMMIT on a single connection. */
export function poolTarget(pool: import('pg').Pool): MigrationTarget {
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
