import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { loadEnv, ROOT } from '../config';
import { createKiteSession, kiteLoginUrl } from '../trading/brokers/kiteClient';
import { setEnvValue } from '../util/envFile';
import { registerSecret } from '../util/log';

// Usage: npm run kite-login   (Kite access tokens expire every morning)
const { apiKey, apiSecret } = loadEnv().kite;
registerSecret(apiSecret);
if (!apiKey || !apiSecret) {
  console.error('Set KITE_API_KEY and KITE_API_SECRET in .env first.');
  process.exit(1);
}
console.log(`1. Open and log in:\n   ${kiteLoginUrl(apiKey)}\n2. You will be redirected to your app's redirect URL with ?request_token=... in it.`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const input = (await rl.question('3. Paste the request_token (or the whole redirect URL): ')).trim();
rl.close();
const requestToken = input.includes('request_token=') ? new URL(input).searchParams.get('request_token')! : input;
const session = await createKiteSession(apiKey, apiSecret, requestToken);
registerSecret(session.access_token);
// Save the token into .env (never print it: screenshots of this window would leak it).
const envPath = resolve(ROOT, '.env');
console.log(`\nLogged in as ${session.user_id}.`);
try {
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  writeFileSync(envPath, setEnvValue(text, 'KITE_ACCESS_TOKEN', session.access_token));
  console.log('Saved the new access token to .env (KITE_ACCESS_TOKEN). It is valid until about 6 AM tomorrow.');
  console.log('The website picks it up within 30 seconds; the trading engine needs a restart.');
} catch (e) {
  console.error(`Could not write .env (${(e as Error).message}). Open .env and set KITE_ACCESS_TOKEN by hand; the token is not shown here for safety.`);
  process.exit(1);
}

