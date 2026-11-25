import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Candle } from '../types';
import { writeJsonAtomic } from '../util/fs';
import { hhmm, istParts } from '../util/time';
import { ema } from './indicators';

/**
 * The intraday desk: the three intraday strategies from the owner's strategy document, PAPER only.
 *   - 9:30 opening range (5-minute): mark the 9:15-9:30 high and low, trade the break and retest.
 *   - Camarilla pivots + 20 EMA (5-minute): buy a strong candle from S3, sell short a strong candle from R3,
 *     confirmed by the 20 EMA.
 *   - Fibonacci + 20 EMA (15-minute): in a clear trend, buy/sell the 50-61.8% retracement near the 20 EMA
 *     after a confirmation candle, entering beyond that candle.
 * Long and short (intraday shorts are allowed in India); every trade has a stop-loss and a 1:2 target,
 * risks at most `riskPerTrade` of the account, and is closed by `squareOff` (15:15 IST) the same day.
 * Profit or loss is booked to the paper account when a trade closes.
 */

export type IntradayStrategyId = 'orb930' | 'camarilla' | 'fib20';
export type IntradaySide = 'long' | 'short';

export interface IntradayConfig {
  enabled: boolean;
  /** Most of the account that open intraday trades may use at once. */
  allocationPct: number;
  riskPerTrade: number;
  /** Largest single intraday trade, as a share of the account. */
  maxPositionPct: number;
  maxTradesPerDay: number;
  /** Charges per side (STT, exchange, stamp, GST, approximately) and slippage per fill. */
  costPct: number;
  slippagePct: number;
  /** No new trades after this time; everything is closed at `squareOff`. */
  lastEntry: string;
  squareOff: string;
  strategies: Record<IntradayStrategyId, boolean>;
}

export const DEFAULT_INTRADAY: IntradayConfig = {
  enabled: true,
  allocationPct: 0.2,
  riskPerTrade: 0.01,
  maxPositionPct: 0.1,
  maxTradesPerDay: 6,
  costPct: 0.0003,
  slippagePct: 0.0005,
  lastEntry: '15:00',
  squareOff: '15:15',
  strategies: { orb930: true, camarilla: true, fib20: true },
};

export const intradaySettings = (c?: Partial<IntradayConfig>): IntradayConfig => ({
  ...DEFAULT_INTRADAY,
  ...(c ?? {}),
  strategies: { ...DEFAULT_INTRADAY.strategies, ...(c?.strategies ?? {}) },
});

export const INTRADAY_STRATEGIES: { id: IntradayStrategyId; name: string; timeframe: string; summary: string; buy: string; sell: string }[] = [
  {
    id: 'orb930',
    name: '9:30 opening range breakout',
    timeframe: '5-minute',
    summary: 'Marks the high and low of the first 15 minutes (9:15-9:30) and trades the breakout once the price comes back to test the line and holds.',
    buy: 'A 5-minute close above the 9:15-9:30 high, then a candle that dips back to that high and closes above it (green). Stop below that candle; target 1:2.',
    sell: 'A 5-minute close below the 9:15-9:30 low, then a candle that rises back to that low and closes below it (red): sell short. Stop above that candle; target 1:2.',
  },
  {
    id: 'camarilla',
    name: 'Camarilla pivots + 20 EMA',
    timeframe: '5-minute',
    summary: "Uses yesterday's high, low and close to draw the Camarilla levels. Buys from the S3 support and sells short from the R3 resistance when a strong candle forms there, with the 20 EMA confirming.",
    buy: 'A candle touches S3 and closes back above it as a strong green candle (body at least 60% of its range), above the 20 EMA. Stop below the candle; target 1:2.',
    sell: 'A candle touches R3 and closes back below it as a strong red candle, below the 20 EMA: sell short. Stop above the candle; target 1:2.',
  },
  {
    id: 'fib20',
    name: 'Fibonacci + 20 EMA',
    timeframe: '15-minute',
    summary: 'In a clear trend, waits for the price to pull back to the 50% or 61.8% Fibonacci level near the 20 EMA, then enters beyond a confirmation candle.',
    buy: 'Price above the 20 EMA after a swing low then swing high; the pullback reaches 50-61.8% near the 20 EMA; a green 15-minute candle confirms; buy when the price goes above its high. Stop below the swing low; target 1:2.',
    sell: 'Price below the 20 EMA after a swing high then swing low; the bounce reaches 50-61.8% near the 20 EMA; a red candle confirms; sell short below its low. Stop above the swing high; target 1:2.',
  },
];

export interface IntradaySignal {
  side: IntradaySide;
  /** Entry at this price, or (with `trigger`) only once the live price goes beyond it. */
  entry: number;
  trigger?: number;
  stop: number;
  target: number;
  reason: string;
}

const TARGET_R = 2;
const OPEN = hhmm('09:15');
const RANGE_END = hhmm('09:30');
const ist = (c: Candle) => istParts(c.time);

/** Completed bars of one session (IST date), in time order. */
export function sessionBars(bars: Candle[], date: string): Candle[] {
  return bars.filter((c) => ist(c).date === date).sort((a, b) => a.time.getTime() - b.time.getTime());
}

/** Joins 5-minute bars into `minutes`-long bars aligned to 9:15 IST. */
export function aggregate(bars: Candle[], minutes: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | undefined;
  let key = '';
  for (const c of [...bars].sort((a, b) => a.time.getTime() - b.time.getTime())) {
    const t = ist(c);
    const k = `${t.date}|${Math.floor((t.minutes - OPEN) / minutes)}`;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { ...c };
    } else {
      cur!.high = Math.max(cur!.high, c.high);
      cur!.low = Math.min(cur!.low, c.low);
      cur!.close = c.close;
      cur!.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Camarilla levels from the previous session's high, low and close. */
export function camarilla(h: number, l: number, c: number) {
  const r = h - l;
  return { r3: c + (r * 1.1) / 4, s3: c - (r * 1.1) / 4, r4: c + (r * 1.1) / 2, s4: c - (r * 1.1) / 2 };
}

const withTarget = (side: IntradaySide, entry: number, stop: number, reason: string, trigger?: number): IntradaySignal | undefined => {
  const risk = side === 'long' ? entry - stop : stop - entry;
  if (!(risk > entry * 0.001)) return undefined; // stop on the wrong side or too close to be real
  const target = side === 'long' ? entry + TARGET_R * risk : entry - TARGET_R * risk;
  return { side, entry, stop, target, reason, ...(trigger !== undefined ? { trigger } : {}) };
};

/** 9:30 opening range: break, then a retest on the last completed 5-minute bar. */
export function orbSignal(bars5: Candle[], today: string): IntradaySignal | string {
  const s = sessionBars(bars5, today);
  const range = s.filter((c) => ist(c).minutes < RANGE_END);
  if (range.length < 3) return 'opening range (9:15-9:30) not complete';
  const hi = Math.max(...range.map((c) => c.high));
  const lo = Math.min(...range.map((c) => c.low));
  const after = s.filter((c) => ist(c).minutes >= RANGE_END);
  if (after.length < 2) return 'waiting for a breakout';
  const last = after.at(-1)!;
  const before = after.slice(0, -1);
  if (before.some((c) => c.close > hi) && last.low <= hi * 1.001 && last.close > hi && last.close > last.open) {
    return withTarget('long', last.close, Math.min(last.low, hi) * 0.999, `broke the opening-range high ₹${hi.toFixed(2)} and the retest held`) ?? 'risk too small';
  }
  if (before.some((c) => c.close < lo) && last.high >= lo * 0.999 && last.close < lo && last.close < last.open) {
    return withTarget('short', last.close, Math.max(last.high, lo) * 1.001, `broke the opening-range low ₹${lo.toFixed(2)} and the retest failed`) ?? 'risk too small';
  }
  return 'no break-and-retest of the opening range';
}

/** Camarilla S3 buy / R3 short on the last completed 5-minute bar, confirmed by the 20 EMA. */
export function camarillaSignal(bars5: Candle[], today: string): IntradaySignal | string {
  const sorted = [...bars5].sort((a, b) => a.time.getTime() - b.time.getTime());
  const days = [...new Set(sorted.map((c) => ist(c).date))].filter((d) => d < today);
  const prevDay = days.at(-1);
  if (!prevDay) return "no previous session for the pivot levels";
  const prev = sessionBars(sorted, prevDay);
  const lv = camarilla(Math.max(...prev.map((c) => c.high)), Math.min(...prev.map((c) => c.low)), prev.at(-1)!.close);
  const s = sessionBars(sorted, today);
  if (!s.length || ist(s.at(-1)!).minutes < RANGE_END) return 'waiting for 9:30';
  const e20 = ema(sorted.map((c) => c.close), 20);
  const k = sorted.length - 1;
  const bar = sorted[k]!;
  const avg = e20[k]!;
  if (Number.isNaN(avg)) return '20 EMA not ready';
  const body = Math.abs(bar.close - bar.open);
  const strong = bar.high > bar.low && body >= 0.6 * (bar.high - bar.low);
  if (bar.low <= lv.s3 && bar.close > lv.s3 && bar.close > bar.open && strong && bar.close > avg) {
    return withTarget('long', bar.close, bar.low * 0.999, `strong green candle from Camarilla S3 ₹${lv.s3.toFixed(2)}, above the 20 EMA`) ?? 'risk too small';
  }
  if (bar.high >= lv.r3 && bar.close < lv.r3 && bar.close < bar.open && strong && bar.close < avg) {
    return withTarget('short', bar.close, bar.high * 1.001, `strong red candle from Camarilla R3 ₹${lv.r3.toFixed(2)}, below the 20 EMA`) ?? 'risk too small';
  }
  return `no strong candle at S3 ₹${lv.s3.toFixed(2)} / R3 ₹${lv.r3.toFixed(2)}`;
}

/** Fibonacci 50-61.8% pullback near the 20 EMA on the last completed 15-minute bar (the confirmation candle). */
export function fibSignal(bars5: Candle[], ltp: number, now: Date, lookback = 20): IntradaySignal | string {
  // Only finished 15-minute candles (the bucket's last 5-minute bar must be complete).
  const b = aggregate(bars5, 15).filter((c) => {
    const t = ist(c);
    const bucketStart = OPEN + Math.floor((t.minutes - OPEN) / 15) * 15;
    return c.time.getTime() + (bucketStart + 15 - t.minutes) * 60_000 <= now.getTime();
  });
  if (b.length < lookback + 21) return 'not enough 15-minute history';
  const e20 = ema(b.map((c) => c.close), 20);
  const j = b.length - 1;
  const conf = b[j]!;
  const avg = e20[j]!;
  const win = b.slice(j - lookback, j);
  const hiIdx = win.reduce((m, c, i) => (c.high > win[m]!.high ? i : m), 0);
  const loIdx = win.reduce((m, c, i) => (c.low < win[m]!.low ? i : m), 0);
  const H = win[hiIdx]!.high;
  const L = win[loIdx]!.low;
  if (!(H - L > conf.close * 0.005)) return 'no clear swing (sideways)';
  const near = (lvl: number) => Math.abs(avg - lvl) <= conf.close * 0.005;
  const touch = Math.min(conf.low, b[j - 1]!.low);
  const touchUp = Math.max(conf.high, b[j - 1]!.high);
  if (loIdx < hiIdx && conf.close > avg) {
    const z50 = H - 0.5 * (H - L);
    const z618 = H - 0.618 * (H - L);
    if (touch <= z50 && touch >= z618 - 0.05 * (H - L) && (near(z50) || near(z618)) && conf.close > conf.open) {
      if (!(ltp > conf.high)) return `long setup: waiting for the price to go above ₹${conf.high.toFixed(2)}`;
      return withTarget('long', ltp, L * 0.999, `pulled back to the 50-61.8% Fibonacci zone near the 20 EMA; green confirmation candle broken`, conf.high) ?? 'risk too small';
    }
  }
  if (hiIdx < loIdx && conf.close < avg) {
    const z50 = L + 0.5 * (H - L);
    const z618 = L + 0.618 * (H - L);
    if (touchUp >= z50 && touchUp <= z618 + 0.05 * (H - L) && (near(z50) || near(z618)) && conf.close < conf.open) {
      if (!(ltp < conf.low)) return `short setup: waiting for the price to go below ₹${conf.low.toFixed(2)}`;
      return withTarget('short', ltp, H * 1.001, `bounced to the 50-61.8% Fibonacci zone near the 20 EMA; red confirmation candle broken`, conf.low) ?? 'risk too small';
    }
  }
  return 'no Fibonacci pullback setup';
}

// ---------------------------------------------------------------- the desk

export interface IntradayPosition {
  id: string;
  symbol: string;
  strategy: IntradayStrategyId;
  side: IntradaySide;
  qty: number;
  entry: number;
  stop: number;
  target: number;
  /** IST trading day and time the trade was opened. */
  day: string;
  openedAt: string;
  reason: string;
}

interface DeskState {
  day: string;
  positions: Record<string, IntradayPosition>;
  /** symbol|strategy already traded today (one trade per strategy per company per day). */
  done: string[];
  trades: number;
  lastScan?: string;
  seq: number;
}

export interface IntradayDeps {
  cfg: IntradayConfig;
  stateFile: string;
  now: () => Date;
  holidays: string[];
  /** Watchlist companies to scan. */
  symbols: () => string[];
  /** 5-minute candles (several sessions). */
  candles5m: (symbol: string, from: Date) => Promise<Candle[]>;
  ltp: (symbols: string[]) => Promise<Record<string, number>>;
  equity: () => Promise<number>;
  /** Books a closed trade's profit or loss (after charges) to the paper account. */
  book: (amount: number, note: string) => void;
  record: (trade: Record<string, unknown>) => void;
  /** "off", "halt" (no new trades) or "flatten" (close everything now). */
  killSwitch: () => 'off' | 'halt' | 'flatten';
  /** A reason that blocks new trades (e.g. the daily loss limit), if any. */
  blocked?: () => string | undefined;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export class IntradayDesk {
  state: DeskState;

  constructor(private d: IntradayDeps) {
    this.state = this.load();
  }

  private load(): DeskState {
    try {
      if (existsSync(this.d.stateFile)) return JSON.parse(readFileSync(this.d.stateFile, 'utf8')) as DeskState;
    } catch {
      /* unreadable: start fresh */
    }
    return { day: '', positions: {}, done: [], trades: 0, seq: 0 };
  }

  private save() {
    mkdirSync(dirname(this.d.stateFile), { recursive: true });
    writeJsonAtomic(this.d.stateFile, this.state);
  }

  open(): IntradayPosition[] {
    return Object.values(this.state.positions);
  }

  async tick(): Promise<void> {
    const cfg = this.d.cfg;
    if (!cfg.enabled) return;
    const now = this.d.now();
    const t = istParts(now);
    const tradingDay = t.weekday >= 1 && t.weekday <= 5 && !this.d.holidays.includes(t.date);
    // Anything left from an earlier day (e.g. the computer was off at 15:15) is closed at the next price.
    const stale = this.open().filter((p) => p.day !== t.date);
    const squareOff = t.minutes >= hhmm(cfg.squareOff);
    if (!tradingDay || t.minutes < OPEN) {
      if (stale.length && tradingDay) await this.closeAll('square-off (left open from an earlier session)', stale);
      return;
    }
    if (this.state.day !== t.date) {
      this.state = { ...this.state, day: t.date, done: [], trades: 0, lastScan: undefined };
      this.save();
    }
    const ks = this.d.killSwitch();
    if (ks === 'flatten') return this.closeAll('kill switch: sell everything');
    if (squareOff) return this.closeAll(`square-off ${cfg.squareOff} IST (intraday)`);
    if (stale.length) await this.closeAll('square-off (left open from an earlier session)', stale);

    await this.manage();

    // New trades: once per 5-minute bar, from 9:30 until `lastEntry`.
    const slot = `${t.date}|${Math.floor(t.minutes / 5)}`;
    if (t.minutes < RANGE_END || t.minutes >= hhmm(cfg.lastEntry) || this.state.lastScan === slot) return;
    this.state.lastScan = slot;
    this.save();
    if (ks !== 'off') return;
    const block = this.d.blocked?.();
    if (block) return this.d.log.warn(`Intraday: no new trades (${block})`);
    await this.scan(now, t.date);
  }

  /** Stop-loss and target checks for open trades at the latest price. */
  private async manage() {
    const open = this.open();
    if (!open.length) return;
    const px = await this.d.ltp([...new Set(open.map((p) => p.symbol))]);
    for (const p of open) {
      const ltp = px[p.symbol];
      if (!(ltp && ltp > 0)) continue;
      const hitStop = p.side === 'long' ? ltp <= p.stop : ltp >= p.stop;
      const hitTarget = p.side === 'long' ? ltp >= p.target : ltp <= p.target;
      if (hitStop) this.close(p, ltp, 'stop-loss');
      else if (hitTarget) this.close(p, ltp, 'target 1:2 reached');
    }
  }

  private async closeAll(reason: string, which = this.open()) {
    if (!which.length) return;
    let px: Record<string, number> = {};
    try {
      px = await this.d.ltp([...new Set(which.map((p) => p.symbol))]);
    } catch (e) {
      this.d.log.warn(`Intraday: prices unavailable for the square-off (${(e as Error).message}); trying again in the next check`);
      return;
    }
    for (const p of which) {
      const ltp = px[p.symbol];
      if (ltp && ltp > 0) this.close(p, ltp, reason);
    }
  }

  private close(p: IntradayPosition, ltp: number, reason: string) {
    const cfg = this.d.cfg;
    const exit = p.side === 'long' ? ltp * (1 - cfg.slippagePct) : ltp * (1 + cfg.slippagePct);
    const gross = (p.side === 'long' ? exit - p.entry : p.entry - exit) * p.qty;
    const charges = cfg.costPct * (p.entry + exit) * p.qty;
    const pnl = gross - charges;
    delete this.state.positions[p.id];
    this.save();
    this.d.book(pnl, `intraday ${p.symbol} ${p.strategy}`);
    this.d.record({ symbol: p.symbol, side: p.side === 'long' ? 'SELL' : 'COVER', qty: p.qty, price: exit, entryPrice: p.entry, pnl, reason, strategy: p.strategy, intraday: true });
    this.d.log.info(`Intraday ${p.side === 'long' ? 'SELL' : 'COVER'} ${p.symbol} ${p.qty} @ ₹${exit.toFixed(2)} (${reason}); P&L ₹${pnl.toFixed(0)} after charges [${INTRADAY_STRATEGIES.find((s) => s.id === p.strategy)!.name}]`);
  }

  private async scan(now: Date, today: string) {
    const cfg = this.d.cfg;
    const symbols = this.d.symbols();
    if (!symbols.length) return;
    const enabled = INTRADAY_STRATEGIES.filter((s) => cfg.strategies[s.id]);
    let equity: number;
    try {
      equity = await this.d.equity();
    } catch (e) {
      return this.d.log.warn(`Intraday: account value unavailable (${(e as Error).message}); no new trades this round`);
    }
    if (!(equity > 0)) return;
    const from = new Date(now.getTime() - 7 * 86_400_000);
    for (const symbol of symbols) {
      if (this.state.trades >= cfg.maxTradesPerDay) return;
      if (this.open().some((p) => p.symbol === symbol)) continue;
      const todo = enabled.filter((s) => !this.state.done.includes(`${symbol}|${s.id}`));
      if (!todo.length) continue;
      let bars: Candle[];
      let ltp: number | undefined;
      try {
        // Only completed bars: a bar is done 5 minutes after it starts.
        bars = (await this.d.candles5m(symbol, from)).filter((c) => c.time.getTime() + 5 * 60_000 <= now.getTime() && c.close > 0);
        ltp = (await this.d.ltp([symbol]))[symbol];
      } catch (e) {
        this.d.log.warn(`Intraday: ${symbol} data unavailable (${(e as Error).message})`);
        continue;
      }
      if (!bars.length || !(ltp && ltp > 0)) continue;
      for (const s of todo) {
        const sig = s.id === 'orb930' ? orbSignal(bars, today) : s.id === 'camarilla' ? camarillaSignal(bars, today) : fibSignal(bars, ltp, now);
        if (typeof sig === 'string') continue;
        this.enter(symbol, s.id, sig, equity, now);
        break; // one open trade per company
      }
    }
  }

  private enter(symbol: string, strategy: IntradayStrategyId, sig: IntradaySignal, equity: number, now: Date) {
    const cfg = this.d.cfg;
    const price = sig.side === 'long' ? sig.entry * (1 + cfg.slippagePct) : sig.entry * (1 - cfg.slippagePct);
    const perShare = Math.abs(price - sig.stop);
    const inUse = this.open().reduce((a, p) => a + p.entry * p.qty, 0);
    const room = Math.max(0, Math.min(equity * cfg.maxPositionPct, equity * cfg.allocationPct - inUse));
    const qty = Math.floor(Math.min((equity * cfg.riskPerTrade) / perShare, room / price));
    this.state.done.push(`${symbol}|${strategy}`);
    if (qty < 1) {
      this.save();
      return this.d.log.info(`Intraday: skip ${symbol} (${strategy}): no room in the intraday budget or the stop is too far`);
    }
    this.state.seq += 1;
    const p: IntradayPosition = { id: `I${this.state.seq}`, symbol, strategy, side: sig.side, qty, entry: price, stop: sig.stop, target: sig.target, day: istParts(now).date, openedAt: now.toISOString(), reason: sig.reason };
    this.state.positions[p.id] = p;
    this.state.trades += 1;
    this.save();
    const name = INTRADAY_STRATEGIES.find((x) => x.id === strategy)!.name;
    this.d.record({ symbol, side: sig.side === 'long' ? 'BUY' : 'SHORT', qty, price, stop: sig.stop, target: sig.target, reason: sig.reason, strategy, intraday: true });
    this.d.log.info(`Intraday ${sig.side === 'long' ? 'BUY' : 'SHORT'} ${symbol} ${qty} @ ₹${price.toFixed(2)}, stop ₹${sig.stop.toFixed(2)}, target ₹${sig.target.toFixed(2)} (${name}: ${sig.reason})`);
  }
}
