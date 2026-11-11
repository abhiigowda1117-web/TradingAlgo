import 'dotenv/config';
import { openDatabase } from '../server/db/open';
import { explainDbError } from '../server/db/pool';

// Usage: npm run db:migrate   (creates/updates the database tables; safe to run repeatedly)
// Not needed normally: the website server does this itself when it starts.
const database = openDatabase({ databaseUrl: process.env.DATABASE_URL });
try {
  const applied = await database.migrate();
  console.log(`${database.describe}: ${applied.length ? `applied ${applied.join(', ')}` : 'up to date'}.`);
} catch (e) {
  console.error(`Migration failed: ${explainDbError(e)}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
