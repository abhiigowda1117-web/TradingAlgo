import 'dotenv/config';
import { resolve } from 'node:path';
import { ROOT } from '../config';
import { migrate, poolTarget } from '../server/db/migrate';
import { createPool } from '../server/db/pool';

// Usage: npm run db:migrate   (creates/updates the database tables; safe to run repeatedly)
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL in .env first, e.g. postgres://postgres:yourpassword@localhost:5432/algotrade');
  process.exit(1);
}
const pool = createPool(url);
try {
  const applied = await migrate(poolTarget(pool), resolve(ROOT, 'db/migrations'));
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (e) {
  console.error(`Migration failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
