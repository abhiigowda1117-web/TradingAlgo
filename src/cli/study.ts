import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadStudyConfig, loadTradingConfig, paths } from '../config';
import { GoogleNews } from '../data/googleNews';
import { YahooData } from '../data/yahoo';
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
const universe = symbolList(opts.symbols) ?? cfg.universe;
const yahoo = new YahooData(trading.engine.exchange);
const deps = {
  fundamentals: yahoo,
  news: flags.has('no-news') ? undefined : new GoogleNews(),
  market: flags.has('no-technicals') ? undefined : yahoo,
};

const now = new Date();
const studies: CompanyStudy[] = [];
for (const [i, symbol] of universe.entries()) {
  try {
    const s = await studyCompany(symbol, deps, cfg, trading.strategy, now);
    studies.push(s);
    log.info(`[${i + 1}/${universe.length}] ${symbol.padEnd(12)} combined ${s.combinedScore.toFixed(1).padStart(5)}  fund ${s.fundamental.score.toFixed(1).padStart(5)}  news ${s.sentiment.score.toFixed(2).padStart(5)} (${s.sentiment.articles})  screen ${s.screen.passed ? 'pass' : 'FAIL'}`);
  } catch (e) {
    log.error(`[${i + 1}/${universe.length}] ${symbol}: ${(e as Error).message}`);
  }
  await sleep(400); // be polite to the free data sources
}

const watchlist = buildWatchlist(studies, cfg.watchlist, now);
saveWatchlist(paths.watchlist, watchlist);

const dir = join(paths.reports, now.toISOString().slice(0, 10));
mkdirSync(dir, { recursive: true });
for (const s of studies) writeFileSync(join(dir, `${s.symbol}.md`), companyReport(s, watchlist, now));
writeFileSync(join(dir, 'README.md'), summaryReport(studies, watchlist, now));

console.log(`\nWatchlist (${watchlist.entries.length}) -> ${paths.watchlist}`);
for (const e of watchlist.entries) console.log(`  ${e.symbol.padEnd(12)} ${e.combinedScore.toFixed(1).padStart(5)}  ${e.name}`);
console.log(`Reports -> ${dir}`);
