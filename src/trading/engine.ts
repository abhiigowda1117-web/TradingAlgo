import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TradingConfig } from '../config';
import type { MarketData } from '../data/types';
import { loadWatchlist, type Watchlist } from '../study/watchlist';
import { log } from '../util/log';
import { daysBetween, hhmm, isNseOpen, istParts, sleep } from '../util/time';
import type { Broker } from './brokers/broker';
import { dailyLossBreached, positionSize } from './risk';
import { computeIndicators, entrySignal, exitSignal, warmupBars } from './strategy';

export interface PositionState {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryDate: string;
  initialStop: number;
  stop: number;
  highestClose: number;
  stopOrderId?: string;
  /** IST date the current stop order was placed. Kite stop orders are DAY orders and expire at the close. */
  stopArmedOn?: string;
}

export interface EngineState {
  positions: Record<string, PositionState>;
  day?: string;
  dayStartEquity?: number;
  haltedOn?: string;
  lastEvaluated?: string;
}

export interface EnginePaths {
  watchlist: string;
  state: string;
  trades: string;
  killSwitch: string;
}

export interface EngineDeps {
  broker: Broker;
  market: MarketData;
  cfg: TradingConfig;
  paths: EnginePaths;
  now?: () => Date;
}

export type TickResult = 'stopped' | 'closed' | 'ok';

/**
 * Daily swing-trading engine. During NSE hours it polls every `pollSeconds` to keep protective
 * stops armed and detect stop fills; once a day at `evaluateAt` (just before the close) it runs
 * the strategy: exits and trailing-stop updates for open positions, then new entries drawn only
 * from the company-study watchlist.
 */
export class Engine {
  state: EngineState;
  private now: () => Date;

  constructor(private d: EngineDeps) {
    this.now = d.now ?? (() => new Date());
    this.state = existsSync(d.paths.state) ? (JSON.parse(readFileSync(d.paths.state, 'utf8')) as EngineState) : { positions: {} };
  }

  private save() {
    mkdirSync(dirname(this.d.paths.state), { recursive: true });
    writeFileSync(this.d.paths.state, JSON.stringify(this.state, null, 2));
  }

  private recordTrade(t: Record<string, unknown>) {
    mkdirSync(dirname(this.d.paths.trades), { recursive: true });
    appendFileSync(this.d.paths.trades, JSON.stringify({ time: this.now().toISOString(), broker: this.d.broker.name, ...t }) + '\n');
  }

  async run(): Promise<void> {
    log.info(`Engine started with ${this.d.broker.name} broker, ${Object.keys(this.state.positions).length} open positions`);
    let consecutiveErrors = 0;
    for (;;) {
      try {
        if ((await this.tick()) === 'stopped') return;
        consecutiveErrors = 0;
      } catch (e) {
        const msg = (e as Error).message;
        log.error(`Tick failed: ${msg}`);
        if (/TokenException|api_key|access_token/i.test(msg)) {
          log.error('Kite session is invalid or expired. Run `npm run kite-login`, update KITE_ACCESS_TOKEN, and restart.');
          return;
        }
        if (++consecutiveErrors >= 10) log.error(`${consecutiveErrors} consecutive failures; check connectivity and the broker`);
      }
      await sleep(this.d.cfg.engine.pollSeconds * 1000);
    }
  }

  async tick(): Promise<TickResult> {
    if (existsSync(this.d.paths.killSwitch)) {
      log.warn(`Kill switch ${this.d.paths.killSwitch} present: stopping. Open positions keep their exchange stop orders for today.`);
      return 'stopped';
    }
    const now = this.now();
    if (!isNseOpen(now, this.d.cfg.engine.holidays)) return 'closed';
    const today = istParts(now).date;

    if (this.state.day !== today) await this.startDay(today);
    await this.reconcile(today);
    await this.checkDailyLoss(today);

    if (istParts(now).minutes >= hhmm(this.d.cfg.engine.evaluateAt) && this.state.lastEvaluated !== today) {
      await this.evaluate(today);
      this.state.lastEvaluated = today;
      this.save();
    }
    return 'ok';
  }

  async equity(): Promise<{ equity: number; cash: number; ltp: Record<string, number> }> {
    const syms = Object.keys(this.state.positions);
    const [cash, ltp] = await Promise.all([this.d.broker.getCash(), syms.length ? this.d.broker.getLtp(syms) : Promise.resolve({} as Record<string, number>)]);
    const held = Object.values(this.state.positions).reduce((a, p) => a + p.qty * (ltp[p.symbol] ?? p.entryPrice), 0);
    return { equity: cash + held, cash, ltp };
  }

  private async startDay(today: string) {
    this.state.day = today;
    this.state.dayStartEquity = (await this.equity()).equity;
    this.state.haltedOn = undefined;
    log.info(`New trading day ${today}, equity ₹${this.state.dayStartEquity.toFixed(0)}`);
    this.save();
  }

  /** Detects stop fills and external changes, and makes sure every position has a live stop for today. */
  private async reconcile(today: string) {
    for (const p of Object.values(this.state.positions)) {
      if (p.stopOrderId && p.stopArmedOn === today) {
        const st = await this.d.broker.getStopStatus(p.stopOrderId);
        if (st.status === 'filled') {
          const price = st.avgPrice ?? p.stop;
          log.info(`STOP FILLED ${p.symbol} ${p.qty} @ ₹${price.toFixed(2)}`);
          this.closePosition(p, price, 'stop hit');
          continue;
        }
        if (st.status !== 'pending') {
          log.warn(`Stop order for ${p.symbol} was ${st.status}; re-arming`);
          p.stopOrderId = undefined;
        }
      }

      const qty = await this.d.broker.getPositionQty(p.symbol);
      if (qty <= 0) {
        log.warn(`${p.symbol}: broker shows no position; it was closed outside the engine. Dropping it.`);
        if (p.stopOrderId) await this.d.broker.cancelOrder(p.stopOrderId).catch(() => undefined);
        delete this.state.positions[p.symbol];
        continue;
      }
      if (qty < p.qty) {
        log.warn(`${p.symbol}: broker holds ${qty}, engine expected ${p.qty}; adjusting`);
        p.qty = qty;
        if (p.stopOrderId && p.stopArmedOn === today) await this.d.broker.modifyStop(p.stopOrderId, p.symbol, qty, p.stop);
      }

      if (!p.stopOrderId || p.stopArmedOn !== today) {
        // Yesterday's DAY stop has expired. If price is already through the stop, exit now instead.
        const ltp = (await this.d.broker.getLtp([p.symbol]))[p.symbol];
        if (ltp !== undefined && ltp <= p.stop) {
          await this.exit(p, `price ₹${ltp.toFixed(2)} already below stop ₹${p.stop.toFixed(2)}`);
          continue;
        }
        try {
          p.stopOrderId = await this.d.broker.placeStop(p.symbol, p.qty, p.stop);
          p.stopArmedOn = today;
          log.info(`Stop armed ${p.symbol} ${p.qty} @ ₹${p.stop.toFixed(2)} (order ${p.stopOrderId})`);
        } catch (e) {
          log.error(`Could not place stop for ${p.symbol}: ${(e as Error).message}. Engine will watch the price and exit itself.`);
          p.stopOrderId = undefined;
        }
      }
    }
    this.save();
  }

  private async checkDailyLoss(today: string) {
    if (this.state.haltedOn === today || !this.state.dayStartEquity) return;
    const { equity } = await this.equity();
    if (dailyLossBreached(this.state.dayStartEquity, equity, this.d.cfg.risk)) {
      this.state.haltedOn = today;
      log.warn(`Daily loss limit hit (₹${this.state.dayStartEquity.toFixed(0)} -> ₹${equity.toFixed(0)}). No new entries today.`);
      this.save();
    }
  }

  private closePosition(p: PositionState, price: number, reason: string) {
    const pnl = (price - p.entryPrice) * p.qty;
    this.recordTrade({ symbol: p.symbol, side: 'SELL', qty: p.qty, price, reason, pnl, entryPrice: p.entryPrice, entryDate: p.entryDate });
    delete this.state.positions[p.symbol];
    this.save();
  }

  private async exit(p: PositionState, reason: string) {
    if (p.stopOrderId) {
      await this.d.broker.cancelOrder(p.stopOrderId).catch((e) => log.warn(`Cancel stop ${p.symbol}: ${(e as Error).message}`));
      // The stop may have filled while we were deciding to exit.
      const st = await this.d.broker.getStopStatus(p.stopOrderId);
      if (st.status === 'filled') return this.closePosition(p, st.avgPrice ?? p.stop, 'stop hit');
    }
    const fill = await this.d.broker.marketOrder(p.symbol, 'SELL', p.qty);
    log.info(`SELL ${p.symbol} ${fill.qty} @ ₹${fill.avgPrice.toFixed(2)}: ${reason}`);
    this.closePosition(p, fill.avgPrice, reason);
  }

  private async candles(symbol: string, today: string) {
    const from = new Date(this.now().getTime() - Math.ceil(warmupBars(this.d.cfg.strategy) * 1.6 + 30) * 86_400_000);
    const c = await this.d.market.getDailyCandles(symbol, from, this.now());
    const last = c.at(-1);
    if (!last || istParts(last.time).date !== today) throw new Error(`no candle for today (latest ${last ? istParts(last.time).date : 'none'})`);
    return c;
  }

  /** The once-a-day strategy pass. */
  async evaluate(today: string) {
    const { strategy, risk } = this.d.cfg;

    for (const p of Object.values(this.state.positions)) {
      try {
        const c = await this.candles(p.symbol, today);
        const ind = computeIndicators(c, strategy);
        const d = exitSignal(c, ind, c.length - 1, p, strategy);
        if (d.exit) {
          await this.exit(p, d.reason);
        } else {
          p.highestClose = d.highestClose;
          if (d.stop > p.stop) {
            log.info(`Trail ${p.symbol} stop ₹${p.stop.toFixed(2)} -> ₹${d.stop.toFixed(2)}`);
            p.stop = d.stop;
            if (p.stopOrderId) await this.d.broker.modifyStop(p.stopOrderId, p.symbol, p.qty, p.stop);
          }
        }
      } catch (e) {
        log.error(`Exit check ${p.symbol} failed: ${(e as Error).message}`);
      }
    }
    this.save();

    if (this.state.haltedOn === today) return log.warn('Entries halted for today (daily loss limit)');
    const wl = this.watchlist();
    if (!wl) return;

    for (const entry of wl.entries) {
      if (Object.keys(this.state.positions).length >= risk.maxOpenPositions) break;
      if (this.state.positions[entry.symbol]) continue;
      try {
        const c = await this.candles(entry.symbol, today);
        const sig = entrySignal(c, computeIndicators(c, strategy), c.length - 1, strategy);
        if (!sig.enter) continue;
        const { equity, cash } = await this.equity();
        const price = (await this.d.broker.getLtp([entry.symbol]))[entry.symbol] ?? c.at(-1)!.close;
        const size = positionSize({ equity, cash, price, stop: sig.stop }, risk);
        if (size.qty === 0) {
          log.info(`Skip ${entry.symbol}: ${size.reason}`);
          continue;
        }
        const fill = await this.d.broker.marketOrder(entry.symbol, 'BUY', size.qty);
        log.info(`BUY ${entry.symbol} ${fill.qty} @ ₹${fill.avgPrice.toFixed(2)}, stop ₹${sig.stop.toFixed(2)} (${sig.reason}; ${size.reason}; study score ${entry.combinedScore})`);
        const p: PositionState = {
          symbol: entry.symbol,
          qty: fill.qty,
          entryPrice: fill.avgPrice,
          entryDate: today,
          initialStop: sig.stop,
          stop: sig.stop,
          highestClose: c.at(-1)!.close,
        };
        this.state.positions[entry.symbol] = p;
        this.recordTrade({ symbol: entry.symbol, side: 'BUY', qty: fill.qty, price: fill.avgPrice, stop: sig.stop, reason: sig.reason, studyScore: entry.combinedScore });
        this.save();
        try {
          p.stopOrderId = await this.d.broker.placeStop(entry.symbol, fill.qty, sig.stop);
          p.stopArmedOn = today;
        } catch (e) {
          log.error(`Bought ${entry.symbol} but could not place its stop: ${(e as Error).message}. Will retry next tick.`);
        }
        this.save();
      } catch (e) {
        log.error(`Entry check ${entry.symbol} failed: ${(e as Error).message}`);
      }
    }
  }

  /** The engine only buys what the latest company study approved, and refuses a stale study. */
  private watchlist(): Watchlist | undefined {
    const wl = loadWatchlist(this.d.paths.watchlist);
    if (!wl) {
      log.warn('No watchlist found. Run `npm run study` first; no new entries.');
      return undefined;
    }
    const age = daysBetween(new Date(wl.generatedAt), this.now());
    if (age > this.d.cfg.engine.watchlistMaxAgeDays) {
      log.warn(`Watchlist is ${age.toFixed(1)} days old (max ${this.d.cfg.engine.watchlistMaxAgeDays}). Re-run \`npm run study\`; no new entries.`);
      return undefined;
    }
    return wl;
  }
}
