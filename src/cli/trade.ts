import { loadTradingConfig, paths } from '../config';
import { broker, loadEnv, marketData } from '../factory';
import { YahooData } from '../data/yahoo';
import { appendFileSync } from 'node:fs';
import { loadWatchlist } from '../study/watchlist';
import { PaperBroker } from '../trading/brokers/paperBroker';
import { Engine } from '../trading/engine';
import { IntradayDesk, intradaySettings } from '../trading/intraday';
import { acquireLock, clearStopRequest } from '../trading/runLock';
import { log, setLogFile } from '../util/log';
import { istParts, sleep } from '../util/time';
import { parseArgs } from './args';

// Usage:
//   npm run trade                      # paper trading (TRADING_MODE=paper)
//   npm run trade -- --live            # real orders; also requires TRADING_MODE=live in .env
//   npm run trade -- --once            # run a single tick and exit (cron-friendly)
//   npm run trade -- --status          # print positions, protection, open orders and equity, then exit
// Kill switch (file named STOP in the project root):
//   touch STOP                 -> no new entries; existing positions stay protected and managed
//   echo FLATTEN > STOP        -> cancel stops, sell every engine position at market, then exit
//   rm STOP                    -> resume normal trading
const { flags } = parseArgs();
const env = loadEnv();
const cfg = loadTradingConfig();
setLogFile(paths.engineLog);

if (env.tradingMode === 'live' && !flags.has('live')) {
  console.error('TRADING_MODE=live but --live was not passed. Refusing to start. Use `npm run trade -- --live`.');
  process.exit(1);
}
if (flags.has('live') && env.tradingMode !== 'live') {
  console.error('--live passed but TRADING_MODE is not "live" in .env. Refusing to start.');
  process.exit(1);
}

const market = marketData(env, cfg);
// NIFTY 50 for the market filter (Yahoo ^NSEI, read-only market data).
const indexData = new YahooData();
const theBroker = broker(env, cfg, market);
// The intraday desk (Fibonacci + 20 EMA, Camarilla pivots, 9:30 opening range): PAPER ONLY.
let intraday: IntradayDesk | undefined;
const engine: Engine = new Engine({
  broker: theBroker,
  market,
  cfg,
  paths: { ...paths, stopRequest: paths.engineStopRequest },
  index: (from, to) => indexData.getTickerCandles('^NSEI', from, to),
  intraday: { tick: async () => intraday?.tick() },
});
const intradayCfg = intradaySettings(cfg.intraday);
if (intradayCfg.enabled && theBroker instanceof PaperBroker) {
  const paper = theBroker;
  intraday = new IntradayDesk({
    cfg: intradayCfg,
    stateFile: paths.intradayState,
    now: () => new Date(),
    holidays: cfg.engine.holidays,
    symbols: () => loadWatchlist(paths.watchlist)?.entries.map((e) => e.symbol) ?? [],
    candles5m: (symbol, from) => indexData.getIntradayCandles(symbol, '5m', from),
    ltp: (symbols) => market.getLtp(symbols),
    equity: async () => (await engine.equity()).equity,
    book: (amount) => paper.bookPnl(amount),
    record: (t) => appendFileSync(paths.trades, JSON.stringify({ time: new Date().toISOString(), broker: 'paper', ...t }) + '\n'),
    killSwitch: () => engine.killSwitch(),
    blocked: () => (engine.state.haltedOn === istParts(new Date()).date ? 'daily loss limit reached' : undefined),
    log,
  });
} else if (intradayCfg.enabled) {
  log.warn('Intraday desk is paper only; it is off in live mode.');
}

if (flags.has('status')) {
  let ltp: Record<string, number> = {};
  try {
    const eq = await engine.equity();
    ltp = eq.ltp;
    console.log(`Mode ${env.tradingMode}. Equity ₹${eq.equity.toFixed(0)}, cash ₹${eq.cash.toFixed(0)}. Kill switch: ${engine.killSwitch()}`);
  } catch (e) {
    console.log(`Mode ${env.tradingMode}. Equity unavailable: ${(e as Error).message}. Kill switch: ${engine.killSwitch()}`);
  }
  for (const p of Object.values(engine.state.positions)) {
    const px = ltp[p.symbol];
    const pnl = px === undefined ? 'n/a' : `₹${((px - p.entryPrice) * p.qty).toFixed(0)}`;
    const prot = p.protection === 'confirmed' ? `stop ${p.protectedQty} @ ₹${p.protectedStop?.toFixed(2)}` : `UNPROTECTED (${p.protection})`;
    console.log(`  ${p.symbol.padEnd(12)} ${p.qty} @ ₹${p.entryPrice.toFixed(2)}  now ${px === undefined ? 'n/a' : `₹${px.toFixed(2)}`}  P&L ${pnl}  ${prot}${p.exitReason ? `  EXITING: ${p.exitReason}` : ''}`);
  }
  const open = Object.values(engine.state.intents).filter((i) => !['complete', 'cancelled', 'rejected', 'not_found', 'expired'].includes(i.status));
  for (const i of open) console.log(`  order ${i.id} ${i.kind} ${i.side} ${i.qty} ${i.symbol}: ${i.status}${i.brokerStatus ? ` (${i.brokerStatus})` : ''}`);
  process.exit(0);
}

// Only one engine may trade the account at a time, whether started here or from the website.
const lock = acquireLock(paths.engineLock, { startedBy: process.env.ALGOTRADE_STARTED_BY || 'terminal', mode: env.tradingMode });
if (!lock.ok) {
  console.error(`Another engine is already running (process ${lock.holder.pid}, started ${lock.holder.startedAt} from ${lock.holder.startedBy}). Stop it first; two engines would double-trade.`);
  process.exit(1);
}
clearStopRequest(paths.engineStopRequest); // an old stop request must not stop this new run

if (env.tradingMode === 'live') {
  log.warn(`LIVE TRADING with real money via Kite. Risk ${cfg.risk.riskPerTrade * 100}% per trade, max ${cfg.risk.maxOpenPositions} positions, max order ₹${cfg.risk.maxOrderValue}. Starting in 10s, Ctrl+C to abort.`);
  await sleep(10_000);
}

if (flags.has('once')) console.log(await engine.tick());
else await engine.run();
