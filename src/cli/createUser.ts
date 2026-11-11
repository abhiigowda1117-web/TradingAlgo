import 'dotenv/config';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { ROOT } from '../config';
import { hashPassword } from '../server/auth/password';
import { openDatabase } from '../server/db/open';
import { explainDbError } from '../server/db/pool';
import { UserRepo } from '../server/db/repositories';
import { parseArgs } from './args';

// Usage: npm run user:create -- --username yourname            full control (your own account)
//        npm run user:create -- --username friend --viewer     view-only: can look, cannot control
// Creates the account, or resets its password if it exists (signing out all sessions).
const { opts, flags } = parseArgs();
const viewer = flags.has('viewer');
const username = (opts.username ?? '').trim().toLowerCase();
if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
  console.error('Usage: npm run user:create -- --username yourname   (3-32 characters: letters, digits, _ . -)');
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
const database = openDatabase({ databaseUrl: process.env.DATABASE_URL });
try {
  await database.migrate();
  const result = await new UserRepo(database.db).upsertOwner(username, await hashPassword(password), !viewer);
  const kind = viewer ? 'View-only account' : 'Account (full control)';
  console.log(result === 'created' ? `${kind} "${username}" created. Start the site and sign in.` : `${kind} "${username}" updated: new password, and existing sessions were signed out.`);
} catch (e) {
  console.error(`Could not save the account: ${explainDbError(e)}`);
  process.exitCode = 1;
} finally {
  await database.close();
}
