import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadStudyConfig, loadTradingConfig, paths } from '../config';
import { readActiveStrategy } from '../trading/activeStrategy';
import { GoogleNews } from '../data/googleNews';
import { RateLimitError, YahooData } from '../data/yahoo';
import { companyReport, summaryReport } from '../study/report';
import { studyCompany, type CompanyStudy } from '../study/study';
import { buildWatchlist, saveWatchlist } from '../study/watchlist';
import { log } from '../util/log';
import { sleep } from '../util/time';
import { parseArgs, symbolList } from './args';

// Usage: npm run study [-- --symbols INFY,TCS] [--no-news] [--no-technicals]
const { flags, opts } = parseArgs();
const cfg = loadStudyConfig();
const trading = loadTradingConfig();
// The study's "entry signal today" column follows the strategy chosen for the engine.
trading.strategy = { ...trading.strategy, name: readActiveStrategy(paths.activeStrategy, trading.strategy.name).name };
const universe = symbolList(opts.symbols) ?? cfg.universe;
const yahoo = new YahooData(trading.engine.exchange);
const deps = {
  fundamentals: yahoo,
  news: flags.has('no-news') ? undefined : new GoogleNews(),
  market: flags.has('no-technicals') ? undefined : yahoo,
};

const now = new Date();
const studies: CompanyStudy[] = [];
let rateLimited = false;
for (const [i, symbol] of universe.entries()) {
  try {
    const s = await studyCompany(symbol, deps, cfg, trading.strategy, now);
    studies.push(s);
    log.info(`[${i + 1}/${universe.length}] ${symbol.padEnd(12)} combined ${s.combinedScore.toFixed(1).padStart(5)}  fund ${s.fundamental.score.toFixed(1).padStart(5)}  news ${s.sentiment.score.toFixed(2).padStart(5)} (${s.sentiment.articles})  screen ${s.screen.passed ? 'pass' : 'FAIL'}`);
  } catch (e) {
    log.error(`[${i + 1}/${universe.length}] ${symbol}: ${(e as Error).message}`);
    if (e instanceof RateLimitError) {
      rateLimited = true;
      break; // more requests now would only extend the block
    }
  }
  await sleep(1500); // be polite to the free data sources
}

if (rateLimited || studies.length === 0) {
  console.error(
    rateLimited
      ? `\nStopped early: Yahoo is rate-limiting this internet connection. Studied ${studies.length} of ${universe.length}.\n` +
          'Wait 15-30 minutes, then try a few symbols first:  npm run study -- --symbols INFY,TCS,ITC'
      : '\nNo company could be studied. Check your internet connection and the errors above.',
  );
  if (studies.length === 0) process.exit(1);
}

const watchlist = buildWatchlist(studies, cfg.watchlist, now);
// A partial study must not replace the watchlist the trading engine relies on.
if (rateLimited) console.error(`Watchlist NOT updated (study incomplete); ${paths.watchlist} keeps the previous version. Reports for the studied companies are still written.\n`);
else saveWatchlist(paths.watchlist, watchlist);

const dir = join(paths.reports, now.toISOString().slice(0, 10));
mkdirSync(dir, { recursive: true });
for (const s of studies) writeFileSync(join(dir, `${s.symbol}.md`), companyReport(s, watchlist, now));
writeFileSync(join(dir, 'README.md'), summaryReport(studies, watchlist, now));

console.log(`\nWatchlist (${watchlist.entries.length})${rateLimited ? ' [not saved]' : ` -> ${paths.watchlist}`}`);
for (const e of watchlist.entries) console.log(`  ${e.symbol.padEnd(12)} ${e.combinedScore.toFixed(1).padStart(5)}  ${e.name}`);
console.log(`Reports -> ${dir}`);
