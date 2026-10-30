import { createInterface } from 'node:readline/promises';
import { loadEnv } from '../config';
import { createKiteSession, kiteLoginUrl } from '../trading/brokers/kiteClient';

// Usage: npm run kite-login   (Kite access tokens expire every morning)
const { apiKey, apiSecret } = loadEnv().kite;
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
console.log(`\nLogged in as ${session.user_id}. Put this in .env:\nKITE_ACCESS_TOKEN=${session.access_token}`);
