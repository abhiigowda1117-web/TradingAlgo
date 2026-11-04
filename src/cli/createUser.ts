import 'dotenv/config';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { ROOT } from '../config';
import { hashPassword } from '../server/auth/password';
import { migrate, poolTarget } from '../server/db/migrate';
import { createPool, explainDbError } from '../server/db/pool';
import { UserRepo } from '../server/db/repositories';
import { parseArgs } from './args';

// Usage: npm run user:create -- --username yourname
// Creates the owner account, or resets its password if it exists (signing out all sessions).
const { opts } = parseArgs();
const username = (opts.username ?? '').trim().toLowerCase();
if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
  console.error('Usage: npm run user:create -- --username yourname   (3-32 characters: letters, digits, _ . -)');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL in .env first.');
  process.exit(1);
}

/** Reads a line without echoing it to the screen. */
function askHidden(question: string): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!prompted) {
        out.output.write(s);
        prompted = true;
      } else if (s.includes('\n') || s.includes('\r')) out.output.write('\n');
    };
    rl.question(question, (answer) => {
      rl.close();
      done(answer);
    });
  });
}

/** Typed at a terminal: hidden prompts. Piped in (scripts): first line password, second line repeat. */
async function readPasswords(): Promise<[string, string]> {
  if (process.stdin.isTTY) return [await askHidden('Password (at least 10 characters): '), await askHidden('Repeat password: ')];
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const [first = '', second = ''] = text.split(/\r?\n/);
  return [first, second];
}

const [password, again] = await readPasswords();
if (password !== again) {
  console.error('Passwords do not match.');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(poolTarget(pool), resolve(ROOT, 'db/migrations'));
  const result = await new UserRepo(pool).upsertOwner(username, await hashPassword(password));
  console.log(result === 'created' ? `Owner account "${username}" created. Start the site and sign in.` : `Password for "${username}" updated; existing sessions were signed out.`);
} catch (e) {
  console.error(`Could not save the account: ${explainDbError(e)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
