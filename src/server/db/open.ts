import { resolve } from 'node:path';
import { ROOT } from '../../config';
import { migrate, poolTarget, type MigrationTarget } from './migrate';
import { createPool } from './pool';
import { SqliteDb } from './sqlite';

export interface OpenDatabase {
  db: MigrationTarget;
  kind: 'sqlite' | 'postgres';
  /** Where the data lives, for messages (never includes a password). */
  describe: string;
  migrate(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * The website's database. Default: the built-in SQLite file data/algotrade.db (nothing to install;
 * copy the data folder to move everything to another computer). Set DATABASE_URL=postgres://... to
 * use a PostgreSQL server instead (for example on a hosting server).
 */
export function openDatabase(o: { databaseUrl?: string; sqlitePath?: string } = {}): OpenDatabase {
  if (o.databaseUrl && /^postgres(ql)?:\/\//.test(o.databaseUrl)) {
    const pool = createPool(o.databaseUrl);
    const db = poolTarget(pool);
    return {
      db,
      kind: 'postgres',
      describe: `PostgreSQL at ${new URL(o.databaseUrl).host}`,
      migrate: () => migrate(db, resolve(ROOT, 'db/migrations')),
      close: () => pool.end(),
    };
  }
  const path = o.sqlitePath ?? resolve(ROOT, 'data/algotrade.db');
  const db = new SqliteDb(path);
  return {
    db,
    kind: 'sqlite',
    describe: `built-in database file ${path}`,
    migrate: () => migrate(db, resolve(ROOT, 'db/migrations-sqlite')),
    close: async () => db.close(),
  };
}
