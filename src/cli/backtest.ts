import { basename } from 'node:path';
import { loadTradingConfig, paths } from '../config';
import { readCandlesCsv } from '../data/csv';
import { YahooData } from '../data/yahoo';
import { loadWatchlist } from '../study/watchlist';
import { backtest, type BacktestResult } from '../trading/backtest';
import { parseArgs, symbolList } from './args';

// Usage:
//   npm run backtest                               # watchlist symbols, 5 years of Yahoo data
//   npm run backtest -- --symbols INFY,TCS --years 8
//   npm run backtest -- --csv path/to/INFY.csv     # offline, any daily OHLC CSV
//   add --trades to list every trade
const { flags, opts } = parseArgs();
const cfg = loadTradingConfig();

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const results: BacktestResult[] = [];

if (opts.csv) {
  results.push(backtest(basename(opts.csv, '.csv'), readCandlesCsv(opts.csv), cfg));
} else {
  const symbols = symbolList(opts.symbols) ?? loadWatchlist(paths.watchlist)?.entries.map((e) => e.symbol);
  if (!symbols?.length) {
    console.error('No symbols: pass --symbols or run `npm run study` to create a watchlist.');
    process.exit(1);
  }
  const years = Number(opts.years ?? 5);
  const from = new Date(Date.now() - years * 365.25 * 86_400_000);
  const yahoo = new YahooData(cfg.engine.exchange);
  for (const s of symbols) {
    try {
      results.push(backtest(s, await yahoo.getDailyCandles(s, from), cfg));
    } catch (e) {
      console.error(`${s}: ${(e as Error).message}`);
    }
  }
}

console.log('Symbol        Return    CAGR   MaxDD  Sharpe  Trades  Win%    PF   AvgR  Exposure');
for (const r of results) {
  const m = r.metrics;
  console.log(
    `${r.symbol.slice(-12).padEnd(12)} ${pct(m.totalReturn).padStart(7)} ${pct(m.cagr).padStart(7)} ${pct(m.maxDrawdown).padStart(7)} ${m.sharpe.toFixed(2).padStart(6)} ${String(m.trades).padStart(7)} ${pct(m.winRate).padStart(6)} ${(Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞').padStart(5)} ${m.avgR.toFixed(2).padStart(6)} ${pct(m.exposure).padStart(9)}`,
  );
  if (flags.has('trades')) {
    for (const t of r.trades) {
      console.log(`    ${t.entryTime.toISOString().slice(0, 10)} -> ${t.exitTime.toISOString().slice(0, 10)}  ${t.qty} @ ${t.entryPrice.toFixed(2)} -> ${t.exitPrice.toFixed(2)}  ₹${t.pnl.toFixed(0)} (${t.rMultiple.toFixed(2)}R) ${t.exitReason}`);
    }
  }
}
if (results.length > 1) {
  const avg = (f: (r: BacktestResult) => number) => results.reduce((a, r) => a + f(r), 0) / results.length;
  console.log(`\nAverage: return ${pct(avg((r) => r.metrics.totalReturn))}, max DD ${pct(avg((r) => r.metrics.maxDrawdown))}, trades ${avg((r) => r.metrics.trades).toFixed(1)} per symbol`);
}
console.log('\nNote: each symbol is tested on its own with the full starting capital. Costs and slippage are included.');
