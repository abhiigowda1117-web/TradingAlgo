import { companyUpdate, formatUpdate, LiveUpdateSources } from '../research/companyUpdate';
import { parseArgs } from './args';

// Usage:
//   npm run company -- Reliance
//   npm run company -- "Bharat Electronics"
//   npm run company -- BEL --days 7          (news from the last 7 days; default 3)
// Today's price, trend, news and NSE announcements for one company. Read-only: never trades.
const { positional, opts } = parseArgs();
const input = positional.join(' ');
if (!input) {
  console.error('Usage: npm run company -- <company name or NSE symbol>   e.g. npm run company -- Reliance');
  process.exit(1);
}
const days = opts.days ? Number(opts.days) : 3;
if (!Number.isInteger(days) || days < 1 || days > 30) {
  console.error('--days must be a whole number from 1 to 30');
  process.exit(1);
}

try {
  console.log(`Looking up "${input}"...`);
  console.log(formatUpdate(await companyUpdate(input, new LiveUpdateSources(), { newsDays: days })));
} catch (e) {
  console.error(`Could not get an update for "${input}": ${(e as Error).message}`);
  process.exit(1);
}
