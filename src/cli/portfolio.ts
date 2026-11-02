import { join } from 'node:path';
import { loadStudyConfig, loadTradingConfig, ROOT } from '../config';
import { cachedCandles } from '../data/candleCache';
import { membershipFilter, readConstituents } from '../data/constituents';
import { readCandlesCsv, readSeriesCsv } from '../data/csv';
import { RateLimitError, YahooData } from '../data/yahoo';
import { alignBenchmark, buyAndHold, type BenchmarkKind } from '../trading/benchmark';
import { summarizeCurve, summarizeStrategy, type PerformanceSummary } from '../trading/performance';
import { runPortfolioBacktest } from '../trading/portfolioBacktest';
import type { Candle } from '../types';
import { istParts, sleep } from '../util/time';
import { parseArgs, symbolList } from './args';

// Usage:
//   npm run portfolio                                   # 2016-01-01 to today, universe from config/study.json
//   npm run portfolio -- --from 2016-01-01 --to 2025-12-31 --split 2022-01-01
//   npm run portfolio -- --constituents data/nifty50_members.csv     # point-in-time universe (symbol,from,to)
//   npm run portfolio -- --benchmark-csv data/NIFTY50_TRI.csv --benchmark-type TRI
//   npm run portfolio -- --csv-dir mydata                # offline: <SYMBOL>.csv files + NIFTY50.csv
//   add --trades to list every trade, --refresh to re-download cached prices
const { flags, opts } = parseArgs();
const cfg = loadTradingConfig();
const today = istParts(new Date()).date;
const from = opts.from ?? '2016-01-01';
const to = opts.to ?? today;
const dateOk = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
if (!dateOk(from) || !dateOk(to) || from >= to || (opts.split && (!dateOk(opts.split) || opts.split <= from || opts.split >= to))) {
  console.error('Dates must be YYYY-MM-DD with --from < --split < --to.');
  process.exit(1);
}
if (opts['benchmark-csv'] && opts['benchmark-type'] !== 'PRICE' && opts['benchmark-type'] !== 'TRI') {
  console.error('With --benchmark-csv, say what it is: --benchmark-type PRICE or --benchmark-type TRI.');
  process.exit(1);
}

// ---- universe (never today's watchlist)
const members = opts.constituents ? readConstituents(opts.constituents) : undefined;
const universe = symbolList(opts.symbols) ?? (members ? [...new Set(members.map((m) => m.symbol))].sort() : loadStudyConfig().universe);

// ---- data
const warmFrom = new Date(new Date(`${from}T00:00:00Z`).getTime() - 450 * 86_400_000);
const toDate = new Date(`${to}T23:59:59Z`);
const warmKey = warmFrom.toISOString().slice(0, 10);
const yahoo = new YahooData(cfg.engine.exchange);
const cacheDir = join(ROOT, 'data', 'cache', 'yahoo');

async function load(ticker: string, fileName: string): Promise<Candle[]> {
  if (opts['csv-dir']) return readCandlesCsv(join(opts['csv-dir'], `${fileName}.csv`));
  const r = await cachedCandles(cacheDir, `${ticker}_${warmKey}_${to}`, () => yahoo.getTickerCandles(ticker, warmFrom, toDate), { refresh: flags.has('refresh') });
  if (!r.fromCache) await sleep(1000);
  return r.candles;
}

const candles: Record<string, Candle[]> = {};
const missing: string[] = [];
for (const [i, symbol] of universe.entries()) {
  try {
    const c = await load(`${symbol}.${cfg.engine.exchange === 'NSE' ? 'NS' : 'BO'}`, symbol);
    if (c.length === 0) throw new Error('no data');
    candles[symbol] = c;
    process.stdout.write(`\rLoaded ${i + 1}/${universe.length} ${symbol.padEnd(14)}`);
  } catch (e) {
    if (e instanceof RateLimitError) {
      console.error(`\n${e.message}\nPrices already downloaded are cached in ${cacheDir}; re-running later continues from there.`);
      process.exit(1);
    }
    missing.push(`${symbol} (${(e as Error).message})`);
  }
}
console.log();

let benchKind: BenchmarkKind = 'PRICE';
let benchLabel = 'NIFTY 50 price index (Yahoo ^NSEI, excludes dividends)';
let benchSeries: Candle[];
if (opts['benchmark-csv']) {
  benchKind = opts['benchmark-type'] as BenchmarkKind;
  benchSeries = readSeriesCsv(opts['benchmark-csv']);
  benchLabel = `NIFTY 50 ${benchKind === 'TRI' ? 'Total Return Index (dividends reinvested)' : 'price index'} from ${opts['benchmark-csv']}`;
} else if (opts['csv-dir']) {
  benchSeries = readCandlesCsv(join(opts['csv-dir'], 'NIFTY50.csv'));
  benchLabel = `NIFTY 50 price index from ${join(opts['csv-dir'], 'NIFTY50.csv')} (assumed price index)`;
} else {
  benchSeries = await load('^NSEI', 'NIFTY50');
}

// ---- run
const result = runPortfolioBacktest(candles, {
  strategy: cfg.strategy,
  risk: cfg.risk,
  costs: cfg.backtest.costs,
  slippagePct: cfg.backtest.slippagePct,
  initialCapital: cfg.backtest.initialCapital,
  start: from,
  end: to,
  isEligible: members ? membershipFilter(members) : undefined,
});
if (result.calendar.length < 2) {
  console.error('Not enough trading days in the chosen period.');
  process.exit(1);
}
const aligned = alignBenchmark(result.calendar, benchSeries);
const bench = buyAndHold(result.calendar, aligned.values, cfg.backtest.initialCapital, cfg.backtest.costs, cfg.backtest.slippagePct);

const first = result.calendar[0]!;
const last = result.calendar.at(-1)!;
const split = opts.split ?? result.calendar[Math.floor(result.calendar.length * 0.7)]!;
const capital = cfg.backtest.initialCapital;
const dayBefore = (d: string) => result.calendar[result.calendar.indexOf(d) - 1]!;
const periods: [string, string, string][] = [
  ['Full period', first, last],
  ['Training (in-sample)', first, dayBefore(result.calendar.find((d) => d >= split)!)],
  ['Test (out-of-sample)', result.calendar.find((d) => d >= split)!, last],
];

// ---- report
const pct = (x?: number) => (x === undefined ? '' : Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '∞');
const inr = (x?: number) => (x === undefined ? '' : `₹${Math.round(x).toLocaleString('en-IN')}`);
const num = (x?: number) => (x === undefined ? '' : Number.isFinite(x) ? x.toFixed(2) : '∞');
const row = (label: string, a: string, b: string) => console.log(`  ${label.padEnd(24)}${a.padStart(16)}${b.padStart(16)}`);

console.log('\n=== Portfolio backtest vs NIFTY 50 ===');
const universeSource = members ? `point-in-time membership from ${opts.constituents}` : opts.symbols ? 'symbols given with --symbols' : "fixed list from config/study.json: TODAY'S large caps";
console.log(`Universe: ${Object.keys(candles).length} stocks (${universeSource})`);
if (missing.length) console.log(`Excluded, no price data: ${missing.join(', ')}`);
console.log(`Benchmark: ${benchLabel}${aligned.filledDays.length ? `; ${aligned.filledDays.length} missing days filled with the previous close` : ''}`);
console.log(`Capital ₹${capital.toLocaleString('en-IN')} | max ${cfg.risk.maxOpenPositions} positions | risk ${cfg.risk.riskPerTrade * 100}%/trade | slippage ${cfg.backtest.slippagePct * 100}%/fill`);
console.log('Execution: signal at a close -> fill at the next open; stops intraday (gaps fill at the open); sale proceeds usable next session.');

for (const [label, a, b] of periods) {
  const base = a === first ? capital : undefined;
  const s: PerformanceSummary = summarizeStrategy(result, a, b, base);
  const n: PerformanceSummary = summarizeCurve('NIFTY 50', bench.curve, a, b, base);
  console.log(`\n${label}: ${s.from} to ${s.to} (${s.days} trading days)`);
  row('', 'Strategy', 'NIFTY 50');
  row('Start value', inr(s.startValue), inr(n.startValue));
  row('End value (marked)', inr(s.endValue), inr(n.endValue));
  row('Total return', pct(s.totalReturn), pct(n.totalReturn));
  row('CAGR', pct(s.cagr), pct(n.cagr));
  row('Max drawdown', pct(s.maxDrawdown), pct(n.maxDrawdown));
  row('Sharpe (rf = 0)', num(s.sharpe), num(n.sharpe));
  row('Closed trades', String(s.trades), '1 buy');
  row('Win rate', pct(s.winRate), '');
  row('Profit factor', num(s.profitFactor), '');
  row('Average win', inr(s.avgWin), '');
  row('Average loss', inr(s.avgLoss), '');
  row('Exposure (days invested)', pct(s.exposure), '100.0%');
  row('Cash utilisation', pct(s.cashUtilization), '~100%');
  row('Costs (closed trades)', inr(s.costs), a === first ? inr(bench.buyCosts) : '');
}

console.log('\nEnd of test (full period):');
row('', 'Strategy', 'NIFTY 50');
row('After selling everything', inr(result.liquidationValue), inr(bench.liquidationValue));
row('Return after liquidation', pct(result.liquidationValue / capital - 1), pct(bench.liquidationValue / capital - 1));
const c = result.costs;
console.log(`\nStrategy costs, all fills: total ${inr(c.total)} = STT ${inr(c.stt)} + stamp ${inr(c.stamp)} + exchange/SEBI/GST ${inr(c.exchangeSebiGst)} + brokerage ${inr(c.brokerage)} + DP ${inr(c.dp)}; slippage ${inr(c.slippage)} (on top)`);
console.log(`Benchmark costs: buy ${inr(bench.buyCosts)}, sell at end ${inr(bench.sellCosts)}`);
if (result.open.length) {
  console.log(`\nOpen at the end (${result.open.length}):`);
  for (const p of result.open) console.log(`  ${p.symbol.padEnd(12)} ${p.qty} @ ${p.entryPrice.toFixed(2)} since ${p.entryDay}, last ${p.lastPrice.toFixed(2)}, unrealised ${inr(p.unrealizedPnl)}${p.exitPending ? ` (exit pending: ${p.exitPending})` : ''}`);
}
const skippedBy = result.skipped.reduce<Record<string, number>>((a, s) => ({ ...a, [s.reason]: (a[s.reason] ?? 0) + 1 }), {});
if (result.skipped.length) console.log(`\nSignals not taken: ${Object.entries(skippedBy).map(([r, n]) => `${n} x ${r}`).join('; ')}`);
if (flags.has('trades')) {
  console.log('\nTrades:');
  for (const t of result.trades) console.log(`  ${t.entryDay} -> ${t.exitDay}  ${t.symbol.padEnd(12)} ${t.qty} @ ${t.entryPrice.toFixed(2)} -> ${t.exitPrice.toFixed(2)}  net ${inr(t.netPnl)} (costs ${inr(t.costs)})  ${t.exitReason}`);
}

console.log(`
Limitations (read before drawing conclusions):
- ${members ? 'Universe membership is point-in-time from your file; stocks with no price data are excluded (listed above).' : "SURVIVORSHIP BIAS: the universe is a list chosen today (today's large caps by default), i.e. companies that did well enough to be large now. This flatters the strategy."}
- The company-study filter (fundamentals, news) is NOT applied: point-in-time fundamentals are not available, and using today's would be look-ahead.
- Prices are ${opts['csv-dir'] ? `daily candles from ${opts['csv-dir']}` : 'Yahoo daily candles (split-adjusted)'}. Dividends on strategy holdings are not credited.${benchKind === 'TRI' ? ' The TRI benchmark includes dividends, so this comparison slightly favours the benchmark.' : ' The benchmark is a price index without dividends too; real index investors also receive ~1-1.5% a year in dividends.'}
- Capital-gains tax is not deducted from either side (the strategy's short-term gains would be taxed more heavily).
- The live engine trades near 15:10 on the same day; this backtest fills at the next open, which is more conservative.
- Training/test split at ${split}: parameters were not tuned on this data. Any future tuning must use only the training period.
- One historical path is not proof of an edge.`);
