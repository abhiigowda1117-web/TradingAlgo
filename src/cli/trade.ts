import { loadTradingConfig, paths } from '../config';
import { broker, loadEnv, marketData } from '../factory';
import { Engine } from '../trading/engine';
import { log, setLogFile } from '../util/log';
import { sleep } from '../util/time';
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
const engine = new Engine({ broker: broker(env, cfg, market), market, cfg, paths });

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

if (env.tradingMode === 'live') {
  log.warn(`LIVE TRADING with real money via Kite. Risk ${cfg.risk.riskPerTrade * 100}% per trade, max ${cfg.risk.maxOpenPositions} positions, max order ₹${cfg.risk.maxOrderValue}. Starting in 10s, Ctrl+C to abort.`);
  await sleep(10_000);
}

if (flags.has('once')) console.log(await engine.tick());
else await engine.run();
