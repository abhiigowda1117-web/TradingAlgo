import { loadStudyConfig, loadTradingConfig, paths } from '../config';
import { GoogleNews } from '../data/googleNews';
import { YahooData } from '../data/yahoo';
import { companyReport } from '../study/report';
import { studyCompany } from '../study/study';
import { loadWatchlist } from '../study/watchlist';
import { parseArgs } from './args';

// Usage: npm run report -- INFY
const { positional } = parseArgs();
const symbol = positional[0]?.toUpperCase();
if (!symbol) {
  console.error('Usage: npm run report -- <SYMBOL>');
  process.exit(1);
}
const trading = loadTradingConfig();
const yahoo = new YahooData(trading.engine.exchange);
const study = await studyCompany(symbol, { fundamentals: yahoo, news: new GoogleNews(), market: yahoo }, loadStudyConfig(), trading.strategy);
console.log(companyReport(study, loadWatchlist(paths.watchlist)));
