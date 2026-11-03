import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { TradingConfig } from '../config';
import type { MarketData } from '../data/types';
import { loadWatchlist, type Watchlist } from '../study/watchlist';
import type { Side } from '../types';
import { readJson, writeJsonAtomic } from '../util/fs';
import { log } from '../util/log';
import { daysBetween, hhmm, isNseOpen, istParts, sleep } from '../util/time';
import { TERMINAL, toTick, type Broker, type OrderRequest, type OrderSnapshot, type OrderStatus } from './brokers/broker';
import { isAuthError, isDefiniteRejection } from './brokers/errors';
import { costModel, dailyLossBreached, isPositive, positionSize, validateEntryPrice } from './risk';
import { computeIndicators, entrySignal, exitSignal, warmupBars } from './strategy';

/**
 * Lifecycle of one order the engine decided to send. Intents are saved BEFORE the order is sent,
 * carry a unique id that doubles as the broker tag, and are reconciled with the broker every tick.
 *
 * created    saved, send not yet confirmed (after a crash this is treated like `uncertain`)
 * uncertain  the send call failed in a way that does not prove the order was refused
 * working    the broker has the order and it is not final yet
 * unknown    the broker reports a status the engine does not recognise
 * complete / cancelled / rejected   final, as reported by the broker (may carry a partial fill)
 * not_found  repeated lookups by tag over `orderTimeoutSeconds` found no such order: it never arrived
 * expired    a DAY order from an earlier session that the broker no longer reports
 */
export type IntentStatus = 'created' | 'uncertain' | 'working' | 'unknown' | 'complete' | 'cancelled' | 'rejected' | 'not_found' | 'expired';
const FINAL_INTENT: ReadonlySet<IntentStatus> = new Set(['complete', 'cancelled', 'rejected', 'not_found', 'expired']);

export interface OrderIntent {
  id: string;
  kind: 'entry' | 'exit' | 'stop';
  symbol: string;
  side: Side;
  qty: number;
  trigger?: number;
  status: IntentStatus;
  brokerStatus?: OrderStatus;
  orderId?: string;
  filledQty: number;
  avgPrice: number;
  /** Fill quantity and value already applied to positions; makes fill handling idempotent across restarts. */
  appliedQty: number;
  appliedValue: number;
  day: string;
  createdAt: string;
  updatedAt: string;
  notFoundLookups: number;
  /** When a stop-limit was first seen triggered but unfilled. */
  triggeredAt?: string;
  lastError?: string;
  // Entry context, used when the fill arrives.
  plannedStop?: number;
  highestClose?: number;
  reason?: string;
  studyScore?: number;
}

export type Protection = 'confirmed' | 'pending' | 'none';

export interface PositionState {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryDate: string;
  initialStop: number;
  /** Desired stop. The broker may lag behind it until a modification is confirmed. */
  stop: number;
  highestClose: number;
  stopIntentId?: string;
  /** Protection as last confirmed by the broker. Only `confirmed` means a live stop covers `protectedQty`. */
  protection: Protection;
  protectedQty?: number;
  protectedStop?: number;
  exitReason?: string;
  exitIntentId?: string;
  exitAttempts?: number;
  stopFailures?: number;
  stopFailuresOn?: string;
  mismatchCount?: number;
}

export interface EngineState {
  positions: Record<string, PositionState>;
  intents: Record<string, OrderIntent>;
  seq: number;
  day?: string;
  dayStartEquity?: number;
  lastEquity?: number;
  haltedOn?: string;
  lastEvaluated?: string;
}

export interface EnginePaths {
  watchlist: string;
  state: string;
  trades: string;
  killSwitch: string;
  /** Optional: written after every tick so a dashboard can tell whether the engine is alive. */
  heartbeat?: string;
}

export interface EngineDeps {
  broker: Broker;
  market: MarketData;
  cfg: TradingConfig;
  paths: EnginePaths;
  now?: () => Date;
  /** Wait between order-status polls; injectable so tests run instantly. */
  wait?: (ms: number) => Promise<void>;
}

export type KillSwitch = 'off' | 'halt' | 'flatten';
export type TickResult = 'ok' | 'closed' | 'halted' | 'stopped';

/** Per-tick context: why new entries are blocked, if they are. */
interface TickCtx {
  today: string;
  blocked: string[];
}

const MAX_STOP_FAILURES_PER_DAY = 3;
const MAX_EXIT_ATTEMPTS = 3;
const NOT_FOUND_LOOKUPS = 3;
const MISMATCH_CONFIRMATIONS = 2;

/**
 * Daily swing-trading engine. During NSE hours it polls every `pollSeconds`: it reconciles every
 * order intent and position with the broker, keeps a broker-confirmed stop on every position, and
 * handles stop fills and exits. Once a day at `evaluateAt` it runs the strategy: exits and trailing
 * stops for open positions, then new entries drawn only from the company-study watchlist.
 *
 * Safety rules: never send an order without first saving its intent; never treat an uncertain send
 * as failed; never place a second stop while the first one's state is unknown; never sell while a
 * stop is still working; and block new entries whenever anything is uncertain.
 */
export class Engine {
  state: EngineState;
  private now: () => Date;
  private wait: (ms: number) => Promise<void>;
  private warnedExternal = new Set<string>();

  constructor(private d: EngineDeps) {
    this.now = d.now ?? (() => new Date());
    this.wait = d.wait ?? sleep;
    const saved = readJson<Partial<EngineState>>(d.paths.state);
    if (saved?.positions && Object.values(saved.positions).some((p) => 'stopOrderId' in p)) {
      throw new Error(`${d.paths.state} was written by an older engine version without order intents. Close those positions by hand (or delete the paper files) before upgrading.`);
    }
    this.state = { positions: {}, intents: {}, seq: 0, ...saved };
    for (const p of Object.values(this.state.positions)) p.protection ??= 'none';
  }

  private save() {
    writeJsonAtomic(this.d.paths.state, this.state);
  }

  private recordTrade(t: Record<string, unknown>) {
    mkdirSync(dirname(this.d.paths.trades), { recursive: true });
    appendFileSync(this.d.paths.trades, JSON.stringify({ time: this.now().toISOString(), broker: this.d.broker.name, ...t }) + '\n');
  }

  // ---------------------------------------------------------------- main loop

  async run(): Promise<void> {
    log.info(`Engine started with ${this.d.broker.name} broker, ${Object.keys(this.state.positions).length} open positions`);
    let consecutiveErrors = 0;
    for (;;) {
      try {
        const result = await this.tick();
        this.beat(result);
        if (result === 'stopped') return;
        consecutiveErrors = 0;
      } catch (e) {
        this.beat('error', (e as Error).message);
        log.error(`Tick failed: ${(e as Error).message}`);
        if (isAuthError(e)) {
          log.error('Broker session is invalid or expired. Run `npm run kite-login`, update KITE_ACCESS_TOKEN, and restart. Exchange stop orders placed today stay live.');
          return;
        }
        if (++consecutiveErrors >= 10) log.error(`${consecutiveErrors} consecutive failures; check connectivity and the broker`);
      }
      await this.wait(this.d.cfg.engine.pollSeconds * 1000);
    }
  }

  /** Records that the engine is alive (information only; never read back by the engine). */
  private beat(result: string, error?: string) {
    if (!this.d.paths.heartbeat) return;
    try {
      writeJsonAtomic(this.d.paths.heartbeat, { at: this.now().toISOString(), result, error, broker: this.d.broker.name, pid: process.pid });
    } catch (e) {
      log.warn(`Could not write heartbeat: ${(e as Error).message}`);
    }
  }

  /**
   * Emergency kill switch, read from the STOP file:
   * - file exists (empty or "HALT"): no new entries; existing positions stay protected and managed.
   * - file contains "FLATTEN": cancel stops, sell every position at market, then stop the engine.
   * An unreadable file is treated as HALT.
   */
  killSwitch(): KillSwitch {
    if (!existsSync(this.d.paths.killSwitch)) return 'off';
    try {
      return readFileSync(this.d.paths.killSwitch, 'utf8').trim().toUpperCase() === 'FLATTEN' ? 'flatten' : 'halt';
    } catch {
      return 'halt';
    }
  }

  async tick(): Promise<TickResult> {
    const ks = this.killSwitch();
    const now = this.now();
    if (!isNseOpen(now, this.d.cfg.engine.holidays)) return 'closed';
    const ctx: TickCtx = { today: istParts(now).date, blocked: [] };
    if (ks !== 'off') ctx.blocked.push(`kill switch (${ks})`);

    if (this.state.day !== ctx.today) await this.startDay(ctx);
    await this.syncIntents(ctx);
    await this.reconcilePositions(ctx);

    if (ks === 'flatten') {
      for (const p of Object.values(this.state.positions)) this.requestExit(p, 'kill switch: flatten');
      await this.cancelWorkingEntries();
    }
    await this.processExits(ctx);
    await this.manageProtection(ctx);

    if (ks === 'flatten') {
      const busy = Object.values(this.state.intents).some((i) => !FINAL_INTENT.has(i.status) && i.kind !== 'stop');
      if (Object.keys(this.state.positions).length === 0 && !busy) {
        log.warn('Kill switch FLATTEN complete: no open positions. Engine stopped.');
        return 'stopped';
      }
      log.warn(`Kill switch FLATTEN in progress: ${Object.keys(this.state.positions).join(', ') || 'waiting for orders'}`);
      return 'halted';
    }

    await this.checkDailyLoss(ctx);
    if (istParts(now).minutes >= hhmm(this.d.cfg.engine.evaluateAt) && this.state.lastEvaluated !== ctx.today) {
      await this.evaluate(ctx);
      this.state.lastEvaluated = ctx.today;
    }
    this.pruneIntents(ctx.today);
    this.save();
    return ks === 'halt' ? 'halted' : 'ok';
  }

  // ---------------------------------------------------------------- equity & day

  /** Throws if cash or any held position's price is unavailable: equity is never guessed. */
  async equity(): Promise<{ equity: number; cash: number; ltp: Record<string, number> }> {
    const syms = Object.keys(this.state.positions);
    const cash = await this.d.broker.getCash();
    if (!Number.isFinite(cash) || cash < 0) throw new Error(`broker returned invalid cash ${cash}`);
    const ltp = syms.length ? await this.d.broker.getLtp(syms) : {};
    let held = 0;
    for (const p of Object.values(this.state.positions)) {
      const px = ltp[p.symbol];
      if (!isPositive(px)) throw new Error(`no valid price for ${p.symbol} (${px})`);
      held += p.qty * px;
    }
    this.state.lastEquity = cash + held;
    return { equity: cash + held, cash, ltp };
  }

  private async startDay(ctx: TickCtx) {
    this.state.day = ctx.today;
    this.state.haltedOn = undefined;
    for (const p of Object.values(this.state.positions)) p.exitAttempts = 0;
    try {
      this.state.dayStartEquity = (await this.equity()).equity;
      log.info(`New trading day ${ctx.today}, equity ₹${this.state.dayStartEquity.toFixed(0)}`);
    } catch (e) {
      // Fall back to the last equity seen (normally yesterday's close) rather than a figure taken later today,
      // which would hide losses made before it.
      this.state.dayStartEquity = this.state.lastEquity;
      log.error(`New trading day ${ctx.today}: equity unavailable (${(e as Error).message}); using last known ₹${this.state.lastEquity?.toFixed(0) ?? 'none'}`);
    }
    this.save();
  }

  private async checkDailyLoss(ctx: TickCtx) {
    if (this.state.haltedOn === ctx.today) return void ctx.blocked.push('daily loss limit');
    if (!isPositive(this.state.dayStartEquity)) return void ctx.blocked.push('day-start equity unknown');
    let equity: number;
    try {
      equity = (await this.equity()).equity;
    } catch (e) {
      return void ctx.blocked.push(`equity unavailable: ${(e as Error).message}`);
    }
    if (dailyLossBreached(this.state.dayStartEquity, equity, this.d.cfg.risk)) {
      this.state.haltedOn = ctx.today;
      ctx.blocked.push('daily loss limit');
      log.warn(`Daily loss limit hit (₹${this.state.dayStartEquity.toFixed(0)} -> ₹${equity.toFixed(0)}). No new entries today; positions stay protected.`);
    }
  }

  // ---------------------------------------------------------------- intents

  private newIntent(kind: OrderIntent['kind'], symbol: string, side: Side, qty: number, today: string, extra: Partial<OrderIntent> = {}): OrderIntent {
    this.state.seq += 1;
    // Kite tags: alphanumeric, max 20 chars. Kind + date + sequence + random suffix is unique across restarts.
    const id = `${kind[0]!.toUpperCase()}${today.replace(/-/g, '').slice(2)}${this.state.seq.toString(36)}${randomBytes(3).toString('hex')}`.slice(0, 20);
    const ts = this.now().toISOString();
    const intent: OrderIntent = { id, kind, symbol, side, qty, status: 'created', filledQty: 0, avgPrice: 0, appliedQty: 0, appliedValue: 0, day: today, createdAt: ts, updatedAt: ts, notFoundLookups: 0, ...extra };
    this.state.intents[id] = intent;
    return intent;
  }

  /** Saves the intent, then sends it. A non-definite failure leaves it `uncertain` for reconciliation; it is never resent. */
  private async send(intent: OrderIntent): Promise<void> {
    this.save();
    const req: OrderRequest =
      intent.kind === 'stop'
        ? { tag: intent.id, symbol: intent.symbol, side: 'SELL', qty: intent.qty, type: 'SL', trigger: intent.trigger! }
        : { tag: intent.id, symbol: intent.symbol, side: intent.side, qty: intent.qty, type: 'MARKET' };
    try {
      intent.orderId = await this.d.broker.submitOrder(req);
      intent.status = 'working';
    } catch (e) {
      intent.lastError = (e as Error).message;
      intent.status = isDefiniteRejection(e) ? 'rejected' : 'uncertain';
      (intent.status === 'rejected' ? log.error : log.warn)(
        `${intent.kind} ${intent.side} ${intent.qty} ${intent.symbol} [${intent.id}] ${intent.status === 'rejected' ? 'rejected' : 'outcome UNKNOWN, will reconcile by tag, not resend'}: ${intent.lastError}`,
      );
    }
    intent.updatedAt = this.now().toISOString();
    this.save();
  }

  private intentsFor(symbol: string, pred: (i: OrderIntent) => boolean = () => true) {
    return Object.values(this.state.intents).filter((i) => i.symbol === symbol && pred(i));
  }

  private unresolved = (i: OrderIntent) => !FINAL_INTENT.has(i.status) && i.status !== 'working';

  /** Refreshes one intent from the broker and applies any new fills. */
  private async syncIntent(intent: OrderIntent, ctx: TickCtx): Promise<void> {
    if (FINAL_INTENT.has(intent.status)) return;
    let snap: OrderSnapshot | undefined;
    try {
      snap = intent.orderId ? await this.d.broker.getOrder(intent.orderId) : await this.d.broker.findOrderByTag(intent.id);
    } catch (e) {
      intent.lastError = (e as Error).message;
      if (intent.day < ctx.today) {
        // A DAY order from an earlier session that the broker no longer reports. Position reconciliation
        // catches any fill we missed.
        log.warn(`${intent.kind} order ${intent.id} for ${intent.symbol} from ${intent.day} can no longer be looked up; marking expired`);
        intent.status = 'expired';
      } else {
        ctx.blocked.push(`cannot reconcile order ${intent.id} (${intent.symbol})`);
        log.error(`Reconciling ${intent.kind} ${intent.id} for ${intent.symbol} failed: ${intent.lastError}`);
      }
      return;
    }

    const ageSec = (this.now().getTime() - new Date(intent.createdAt).getTime()) / 1000;
    if (!snap) {
      intent.notFoundLookups += 1;
      if (intent.notFoundLookups >= NOT_FOUND_LOOKUPS && ageSec >= this.d.cfg.engine.orderTimeoutSeconds) {
        intent.status = intent.day < ctx.today ? 'expired' : 'not_found';
        log.warn(`${intent.kind} ${intent.id} for ${intent.symbol} not found at the broker after ${intent.notFoundLookups} lookups; it never arrived`);
      } else {
        ctx.blocked.push(`order ${intent.id} (${intent.symbol}) not yet confirmed`);
      }
      return;
    }

    if (snap.tag && snap.tag !== intent.id) log.warn(`Order ${snap.orderId} tag ${snap.tag} does not match intent ${intent.id}`);
    intent.orderId = snap.orderId;
    intent.brokerStatus = snap.status;
    intent.filledQty = snap.filledQty;
    intent.avgPrice = snap.avgPrice;
    intent.qty = snap.qty || intent.qty;
    if (snap.trigger !== undefined) intent.trigger = snap.trigger;
    intent.status = TERMINAL.has(snap.status) ? (snap.status as IntentStatus) : snap.status === 'unknown' ? 'unknown' : 'working';
    intent.updatedAt = this.now().toISOString();
    if (intent.status === 'unknown') {
      ctx.blocked.push(`order ${intent.id} (${intent.symbol}) in unknown state`);
      log.error(`Order ${snap.orderId} (${intent.symbol}) has an unrecognised status; not treating it as filled, cancelled or protective`);
    }
    if (intent.status === 'rejected' || intent.status === 'cancelled') {
      log.warn(`${intent.kind} ${snap.orderId} for ${intent.symbol} ${intent.status}${snap.message ? `: ${snap.message}` : ''} (filled ${snap.filledQty}/${snap.qty})`);
    }
    this.applyFills(intent);

    // A market order that is still working long after submission: cancel the unfilled remainder.
    if (intent.status === 'working' && intent.kind !== 'stop' && ageSec >= this.d.cfg.engine.orderTimeoutSeconds) {
      log.warn(`${intent.kind} ${snap.orderId} for ${intent.symbol} still ${snap.status} after ${ageSec.toFixed(0)}s; cancelling the remainder`);
      await this.d.broker.cancelOrder(snap.orderId).catch((e) => log.error(`Cancel ${snap!.orderId}: ${(e as Error).message}`));
    }
  }

  private async syncIntents(ctx: TickCtx) {
    for (const intent of Object.values(this.state.intents)) {
      if (FINAL_INTENT.has(intent.status)) continue;
      await this.syncIntent(intent, ctx);
      this.save();
    }
  }

  /** Applies the part of an intent's fill not yet reflected in positions. Safe to call repeatedly. */
  private applyFills(intent: OrderIntent) {
    const delta = intent.filledQty - intent.appliedQty;
    if (delta <= 0) return;
    const value = intent.filledQty * intent.avgPrice - intent.appliedValue;
    const price = value / delta;
    intent.appliedQty = intent.filledQty;
    intent.appliedValue = intent.filledQty * intent.avgPrice;

    if (intent.kind === 'entry') {
      const p = (this.state.positions[intent.symbol] ??= {
        symbol: intent.symbol,
        qty: 0,
        entryPrice: 0,
        entryDate: intent.day,
        initialStop: intent.plannedStop!,
        stop: intent.plannedStop!,
        highestClose: intent.highestClose ?? price,
        protection: 'none',
      });
      p.entryPrice = (p.entryPrice * p.qty + value) / (p.qty + delta);
      p.qty += delta;
      log.info(`BUY FILL ${intent.symbol} ${delta} @ ₹${price.toFixed(2)} (now ${p.qty} @ ₹${p.entryPrice.toFixed(2)}, stop ₹${p.stop.toFixed(2)}) [${intent.id}]`);
      this.recordTrade({ symbol: intent.symbol, side: 'BUY', qty: delta, price, stop: p.stop, reason: intent.reason, studyScore: intent.studyScore, intentId: intent.id, orderId: intent.orderId });
    } else {
      const p = this.state.positions[intent.symbol];
      if (!p) {
        log.error(`SELL fill of ${delta} ${intent.symbol} [${intent.id}] has no matching position`);
        return;
      }
      const qty = Math.min(delta, p.qty);
      const reason = intent.kind === 'stop' ? 'stop hit' : (p.exitReason ?? 'exit');
      log.info(`SELL FILL ${intent.symbol} ${qty} @ ₹${price.toFixed(2)}: ${reason} [${intent.id}]`);
      this.recordTrade({ symbol: intent.symbol, side: 'SELL', qty, price, reason, pnl: (price - p.entryPrice) * qty, entryPrice: p.entryPrice, entryDate: p.entryDate, intentId: intent.id, orderId: intent.orderId });
      p.qty -= qty;
      if (p.qty <= 0) {
        delete this.state.positions[intent.symbol];
        log.info(`Position ${intent.symbol} closed`);
      }
    }
    this.save();
  }

  private pruneIntents(today: string) {
    const cutoff = new Date(new Date(`${today}T00:00:00Z`).getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    for (const [id, i] of Object.entries(this.state.intents)) if (FINAL_INTENT.has(i.status) && i.day < cutoff) delete this.state.intents[id];
  }

  private async cancelWorkingEntries() {
    for (const i of Object.values(this.state.intents)) {
      if (i.kind === 'entry' && i.status === 'working' && i.orderId) {
        await this.d.broker.cancelOrder(i.orderId).catch((e) => log.error(`Cancel entry ${i.orderId}: ${(e as Error).message}`));
      }
    }
  }

  // ---------------------------------------------------------------- positions

  /**
   * Compares local positions with the broker. A shortfall must be seen on MISMATCH_CONFIRMATIONS
   * consecutive ticks (with no unresolved orders for the symbol) before it is accepted, so one bad
   * API response cannot drop a position or cancel its stop. A failed lookup changes nothing.
   */
  private async reconcilePositions(ctx: TickCtx) {
    for (const p of Object.values(this.state.positions)) {
      let brokerQty: number;
      try {
        brokerQty = await this.d.broker.getPositionQty(p.symbol);
        if (!Number.isFinite(brokerQty)) throw new Error(`invalid quantity ${brokerQty}`);
      } catch (e) {
        ctx.blocked.push(`position check failed for ${p.symbol}`);
        log.error(`Position check for ${p.symbol} failed: ${(e as Error).message}. Leaving it unchanged.`);
        continue;
      }
      if (brokerQty === p.qty) {
        p.mismatchCount = 0;
        continue;
      }
      if (brokerQty > p.qty) {
        const pendingEntry = this.intentsFor(p.symbol, (i) => i.kind === 'entry' && !FINAL_INTENT.has(i.status)).length > 0;
        if (pendingEntry) ctx.blocked.push(`${p.symbol}: entry order still resolving`);
        else if (!this.warnedExternal.has(p.symbol)) {
          this.warnedExternal.add(p.symbol);
          log.warn(`${p.symbol}: broker holds ${brokerQty}, engine manages ${p.qty}. The extra shares are not managed or protected by the engine.`);
        }
        continue;
      }

      ctx.blocked.push(`${p.symbol}: broker holds ${brokerQty}, engine expects ${p.qty}`);
      if (this.intentsFor(p.symbol, this.unresolved).length > 0) {
        log.warn(`${p.symbol}: broker holds ${brokerQty} < ${p.qty}, but orders are still resolving; waiting`);
        continue;
      }
      p.mismatchCount = (p.mismatchCount ?? 0) + 1;
      if (p.mismatchCount < MISMATCH_CONFIRMATIONS) {
        log.warn(`${p.symbol}: broker holds ${brokerQty}, engine expects ${p.qty} (check ${p.mismatchCount}/${MISMATCH_CONFIRMATIONS}); not acting yet`);
        continue;
      }
      const sold = p.qty - brokerQty;
      log.error(`${p.symbol}: confirmed ${sold} shares left the account outside the engine; adopting broker quantity ${brokerQty}`);
      this.recordTrade({ symbol: p.symbol, side: 'SELL', qty: sold, price: null, reason: 'closed outside engine (price unknown)', entryPrice: p.entryPrice, entryDate: p.entryDate });
      p.qty = brokerQty;
      p.mismatchCount = 0;
      if (p.qty <= 0) {
        const si = p.stopIntentId ? this.state.intents[p.stopIntentId] : undefined;
        if (si?.orderId && si.status === 'working') await this.d.broker.cancelOrder(si.orderId).catch((e) => log.warn(`Cancel stop ${si.orderId}: ${(e as Error).message}`));
        delete this.state.positions[p.symbol];
      }
    }
    this.save();
  }

  // ---------------------------------------------------------------- protection

  /** Keeps a broker-confirmed stop on every position, without ever stacking a second stop on an unresolved one. */
  private async manageProtection(ctx: TickCtx) {
    for (const p of Object.values(this.state.positions)) {
      try {
        await this.protect(p, ctx);
      } catch (e) {
        log.error(`Protecting ${p.symbol} failed: ${(e as Error).message}`);
        p.protection = 'none';
      }
      if (p.protection !== 'confirmed' && !p.exitReason) ctx.blocked.push(`${p.symbol} not protected (${p.protection})`);
    }
    this.save();
  }

  private async ltp(symbol: string): Promise<number | undefined> {
    try {
      const px = (await this.d.broker.getLtp([symbol]))[symbol];
      return isPositive(px) ? px : undefined;
    } catch {
      return undefined;
    }
  }

  private async protect(p: PositionState, ctx: TickCtx) {
    if (p.qty <= 0) return;
    const si = p.stopIntentId ? this.state.intents[p.stopIntentId] : undefined;
    if (p.stopFailuresOn !== ctx.today) {
      p.stopFailures = 0;
      p.stopFailuresOn = ctx.today;
    }

    // While an exit is under way the exit flow owns the stop.
    if (p.exitReason && (p.exitAttempts ?? 0) < MAX_EXIT_ATTEMPTS) {
      p.protection = si?.status === 'working' && si.brokerStatus === 'trigger_pending' ? 'confirmed' : 'none';
      return;
    }

    // An older stop from a previous session: a DAY order the broker has expired.
    if (si && !FINAL_INTENT.has(si.status) && si.day < ctx.today) {
      if (si.status === 'working') si.status = 'expired';
    }

    if (si && !FINAL_INTENT.has(si.status)) {
      if (si.status !== 'working') {
        // created / uncertain / unknown: the stop may or may not be live. Never stack another one.
        p.protection = 'none';
        const px = await this.ltp(p.symbol);
        if (px !== undefined && px <= p.stop) {
          this.requestExit(p, `price ₹${px.toFixed(2)} at or below stop ₹${p.stop.toFixed(2)} while stop is unconfirmed`);
          await this.processExit(p, ctx);
        }
        return;
      }
      if (si.brokerStatus === 'open') {
        // Stop-limit has triggered but its limit has not filled: the price is falling through it.
        si.triggeredAt ??= this.now().toISOString();
        p.protection = 'none';
        const waited = (this.now().getTime() - new Date(si.triggeredAt).getTime()) / 1000;
        if (waited >= this.d.cfg.engine.triggeredStopGraceSeconds) {
          this.requestExit(p, `stop triggered but unfilled for ${waited.toFixed(0)}s`);
          await this.processExit(p, ctx);
        }
        return;
      }
      if (si.brokerStatus !== 'trigger_pending') {
        p.protection = 'pending';
        return;
      }
      // Live stop. Bring it in line with the desired quantity and trigger; the local record changes only
      // after the broker confirms.
      const wantTrigger = toTick(p.stop);
      if (si.qty !== p.qty || (si.trigger ?? 0) < wantTrigger) {
        try {
          await this.d.broker.modifyStop(si.orderId!, p.qty, p.stop);
          const snap = await this.d.broker.getOrder(si.orderId!);
          si.brokerStatus = snap.status;
          if (snap.trigger !== undefined) si.trigger = snap.trigger;
          si.qty = snap.qty;
          log.info(`Stop ${p.symbol} now ${snap.qty} @ ₹${snap.trigger?.toFixed(2)} (wanted ${p.qty} @ ₹${wantTrigger.toFixed(2)})`);
        } catch (e) {
          log.error(`Modifying stop for ${p.symbol} failed: ${(e as Error).message}. Broker stop stays ${si.qty} @ ₹${si.trigger?.toFixed(2)}; will retry.`);
        }
      }
      const covered = si.brokerStatus === 'trigger_pending' && si.qty >= p.qty;
      p.protection = covered ? 'confirmed' : 'pending';
      p.protectedQty = si.qty;
      p.protectedStop = si.trigger;
      return;
    }

    // No live stop: place one, unless the price is already through it.
    p.protection = 'none';
    p.protectedQty = undefined;
    p.protectedStop = undefined;
    const px = await this.ltp(p.symbol);
    if (px !== undefined && px <= p.stop) {
      this.requestExit(p, `price ₹${px.toFixed(2)} already at or below stop ₹${p.stop.toFixed(2)}`);
      await this.processExit(p, ctx);
      return;
    }
    if ((p.stopFailures ?? 0) >= MAX_STOP_FAILURES_PER_DAY) {
      log.error(`${p.symbol} has NO stop: ${p.stopFailures} placements rejected today. Engine is watching the price and will exit at ₹${p.stop.toFixed(2)}. Check the broker.`);
      return;
    }
    const intent = this.newIntent('stop', p.symbol, 'SELL', p.qty, ctx.today, { trigger: toTick(p.stop) });
    p.stopIntentId = intent.id;
    await this.send(intent);
    if (intent.status === 'rejected') {
      p.stopFailures = (p.stopFailures ?? 0) + 1;
      return;
    }
    // A new stop passes through broker validation before it is live; give it a few seconds.
    const live = (i: OrderIntent) => i.status === 'working' && i.brokerStatus === 'trigger_pending';
    for (let n = 0; n < 5 && intent.status === 'working' && !live(intent); n++) {
      await this.syncIntent(intent, ctx);
      if (!live(intent)) await this.wait(1000);
    }
    p.protection = live(intent) ? 'confirmed' : intent.status === 'working' ? 'pending' : 'none';
    if (p.protection === 'confirmed') {
      p.protectedQty = intent.qty;
      p.protectedStop = intent.trigger;
      log.info(`Stop confirmed ${p.symbol} ${intent.qty} @ ₹${intent.trigger?.toFixed(2)} (order ${intent.orderId})`);
    }
  }

  // ---------------------------------------------------------------- exits

  private requestExit(p: PositionState, reason: string) {
    if (p.exitReason) return;
    p.exitReason = reason;
    p.exitAttempts = 0;
    log.warn(`EXIT requested ${p.symbol}: ${reason}`);
  }

  private async processExits(ctx: TickCtx) {
    for (const p of Object.values(this.state.positions)) {
      if (!p.exitReason) continue;
      try {
        await this.processExit(p, ctx);
      } catch (e) {
        log.error(`Exit for ${p.symbol} failed: ${(e as Error).message}`);
      }
    }
    this.save();
  }

  /**
   * Exit sequence: (1) make sure no stop can still fill (cancel it and wait for the broker to confirm),
   * (2) send one market SELL for the remaining quantity, (3) after it is final, retry only for the
   * confirmed remainder. If exits keep failing, give up and let protection re-arm a stop.
   */
  private async processExit(p: PositionState, ctx: TickCtx) {
    const exitIntent = p.exitIntentId ? this.state.intents[p.exitIntentId] : undefined;
    if (exitIntent && !FINAL_INTENT.has(exitIntent.status)) return; // still resolving
    if (exitIntent && exitIntent.filledQty > 0) p.exitAttempts = 0; // progress made: only failures count

    const si = p.stopIntentId ? this.state.intents[p.stopIntentId] : undefined;
    if (si && !FINAL_INTENT.has(si.status)) {
      if (si.status !== 'working' || !si.orderId) {
        log.warn(`${p.symbol}: waiting for stop ${si.id} (${si.status}) to resolve before selling`);
        return;
      }
      try {
        await this.d.broker.cancelOrder(si.orderId);
      } catch (e) {
        log.warn(`Cancel stop ${si.orderId} for ${p.symbol}: ${(e as Error).message}`);
      }
      await this.syncIntent(si, ctx);
      if (!this.state.positions[p.symbol]) return; // the stop filled instead
      if (!FINAL_INTENT.has(si.status)) {
        log.warn(`${p.symbol}: stop ${si.orderId} not confirmed cancelled yet (${si.brokerStatus}); not selling`);
        return;
      }
    }

    if (p.qty <= 0) return;
    if ((p.exitAttempts ?? 0) >= MAX_EXIT_ATTEMPTS) {
      log.error(`${p.symbol}: ${p.exitAttempts} exit attempts failed; re-arming a protective stop. Exit by hand if needed.`);
      p.exitReason = undefined;
      return;
    }
    p.exitAttempts = (p.exitAttempts ?? 0) + 1;
    const intent = this.newIntent('exit', p.symbol, 'SELL', p.qty, ctx.today);
    p.exitIntentId = intent.id;
    p.protection = 'none';
    await this.send(intent);
    if (intent.status === 'working') await this.resolveSoon(intent, ctx);
    if (!this.state.positions[p.symbol]) return;
    if (FINAL_INTENT.has(intent.status) && p.qty > 0) log.warn(`${p.symbol}: exit ${intent.status}, ${p.qty} shares remain; will retry`);
  }

  /** Polls a just-sent order until it is final or `orderTimeoutSeconds` passes; whatever is left is handled next tick. */
  private async resolveSoon(intent: OrderIntent, ctx: TickCtx) {
    const deadline = Date.now() + this.d.cfg.engine.orderTimeoutSeconds * 1000;
    for (let i = 0; ; i++) {
      await this.syncIntent(intent, ctx);
      if (FINAL_INTENT.has(intent.status) || Date.now() >= deadline || i >= 30) return;
      await this.wait(1000);
    }
  }

  // ---------------------------------------------------------------- strategy

  private async candles(symbol: string, today: string) {
    const from = new Date(this.now().getTime() - Math.ceil(warmupBars(this.d.cfg.strategy) * 1.6 + 30) * 86_400_000);
    const c = await this.d.market.getDailyCandles(symbol, from, this.now());
    const last = c.at(-1);
    if (!last || istParts(last.time).date !== today) throw new Error(`no candle for today (latest ${last ? istParts(last.time).date : 'none'})`);
    if (c.some((x) => ![x.open, x.high, x.low, x.close].every(isPositive))) throw new Error('candles contain invalid prices');
    return c;
  }

  /** The once-a-day strategy pass. */
  async evaluate(ctx: TickCtx) {
    const { strategy, risk } = this.d.cfg;

    for (const p of Object.values(this.state.positions)) {
      if (p.exitReason) continue;
      try {
        const c = await this.candles(p.symbol, ctx.today);
        const d = exitSignal(c, computeIndicators(c, strategy), c.length - 1, p, strategy);
        if (d.exit) {
          this.requestExit(p, d.reason);
          await this.processExit(p, ctx);
        } else {
          p.highestClose = d.highestClose;
          if (d.stop > p.stop) {
            log.info(`Trail ${p.symbol} desired stop ₹${p.stop.toFixed(2)} -> ₹${d.stop.toFixed(2)}`);
            p.stop = d.stop;
          }
        }
      } catch (e) {
        log.error(`Exit check ${p.symbol} failed: ${(e as Error).message}`);
      }
    }
    await this.manageProtection(ctx); // push trailed stops to the broker
    this.save();

    if (ctx.blocked.length) return log.warn(`No new entries: ${[...new Set(ctx.blocked)].join('; ')}`);
    const wl = this.watchlist();
    if (!wl) return;

    for (const entry of wl.entries) {
      if (this.killSwitch() !== 'off') return log.warn('Kill switch activated during evaluation; no further entries');
      const inFlight = Object.values(this.state.intents).filter((i) => i.kind === 'entry' && !FINAL_INTENT.has(i.status) && !this.state.positions[i.symbol]);
      if (Object.keys(this.state.positions).length + inFlight.length >= risk.maxOpenPositions) break;
      if (this.state.positions[entry.symbol]) continue;
      // One entry attempt per symbol per day, whatever happened to it. Restarting mid-evaluation cannot double-buy.
      if (this.intentsFor(entry.symbol, (i) => i.kind === 'entry' && (i.day === ctx.today || !FINAL_INTENT.has(i.status))).length) continue;
      try {
        const c = await this.candles(entry.symbol, ctx.today);
        const sig = entrySignal(c, computeIndicators(c, strategy), c.length - 1, strategy);
        if (!sig.enter) continue;

        const px = (await this.d.broker.getLtp([entry.symbol]))[entry.symbol];
        const bad = validateEntryPrice(px, c.at(-1)!.close, risk.maxPriceDeviationPct);
        if (bad) {
          log.warn(`Skip ${entry.symbol}: ${bad}`);
          continue;
        }
        const price = px!;
        if (sig.stop >= price) {
          log.warn(`Skip ${entry.symbol}: live price ₹${price} is at or below the planned stop ₹${sig.stop.toFixed(2)}`);
          continue;
        }

        const { equity, cash, ltp } = await this.equity();
        if (dailyLossBreached(this.state.dayStartEquity ?? NaN, equity, risk)) return log.warn('Daily loss limit reached during evaluation; no further entries');
        const exposure =
          Object.values(this.state.positions).reduce((a, p) => a + p.qty * ltp[p.symbol]!, 0) +
          inFlight.reduce((a, i) => a + (i.qty - i.appliedQty) * price, 0);
        const size = positionSize({ equity, cash, price, stop: sig.stop, exposure }, risk, costModel(this.d.cfg));
        if (size.qty === 0) {
          log.info(`Skip ${entry.symbol}: ${size.reason}`);
          continue;
        }

        const intent = this.newIntent('entry', entry.symbol, 'BUY', size.qty, ctx.today, {
          plannedStop: sig.stop,
          highestClose: c.at(-1)!.close,
          reason: sig.reason,
          studyScore: entry.combinedScore,
        });
        log.info(`BUY ${entry.symbol} ${size.qty} @ ~₹${price.toFixed(2)}, stop ₹${sig.stop.toFixed(2)} (${sig.reason}; ${size.reason}; study score ${entry.combinedScore}) [${intent.id}]`);
        await this.send(intent);
        if (intent.status === 'working') await this.resolveSoon(intent, ctx);
        const p = this.state.positions[entry.symbol];
        if (p) await this.protect(p, ctx);
        this.save();
        if (!FINAL_INTENT.has(intent.status) || (p && p.protection !== 'confirmed')) {
          return log.warn(`${entry.symbol}: entry or its stop is not settled yet; no further entries this pass`);
        }
      } catch (e) {
        log.error(`Entry check ${entry.symbol} failed: ${(e as Error).message}`);
        if (isAuthError(e)) throw e;
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
    if (!Number.isFinite(age) || age > this.d.cfg.engine.watchlistMaxAgeDays) {
      log.warn(`Watchlist is ${age.toFixed(1)} days old (max ${this.d.cfg.engine.watchlistMaxAgeDays}). Re-run \`npm run study\`; no new entries.`);
      return undefined;
    }
    return wl;
  }
}
