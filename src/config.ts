import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StrategyName } from './trading/strategyIds';
import type { CostSchedule } from './trading/costs';
import { intradaySettings, type IntradayConfig } from './trading/intraday';
import { validateTradingConfig } from './trading/risk';
import type { MetricKey } from './types';

export const ROOT = resolve(import.meta.dirname, '..');
export const paths = {
  studyConfig: resolve(ROOT, 'config/study.json'),
  tradingConfig: resolve(ROOT, 'config/trading.json'),
  watchlist: resolve(ROOT, 'data/watchlist.json'),
  state: resolve(ROOT, 'data/state.json'),
  paperAccount: resolve(ROOT, 'data/paper-account.json'),
  trades: resolve(ROOT, 'data/trades.jsonl'),
  reports: resolve(ROOT, 'reports'),
  engineLog: resolve(ROOT, 'logs/engine.log'),
  killSwitch: resolve(ROOT, 'STOP'),
  heartbeat: resolve(ROOT, 'data/heartbeat.json'),
  backtestResult: resolve(ROOT, 'data/backtests/latest.json'),
  jobsLog: resolve(ROOT, 'logs/jobs'),
  manualOrders: resolve(ROOT, 'data/manual-orders'),
  activeStrategy: resolve(ROOT, 'data/active-strategy.json'),
  activeProfile: resolve(ROOT, 'data/active-profile.json'),
  engineWanted: resolve(ROOT, 'data/engine.wanted'),
  intradayState: resolve(ROOT, 'data/intraday.json'),
  presets: resolve(ROOT, 'data/presets-applied.json'),
  strategyLab: resolve(ROOT, 'data/backtests/lab.json'),
  engineLock: resolve(ROOT, 'data/engine.lock'),
  engineStopRequest: resolve(ROOT, 'data/engine.stop-request'),
};

export type CompareOp = '>' | '>=' | '<' | '<=';

export interface ScreenRule {
  metric: MetricKey;
  op: CompareOp;
  value: number;
}

export interface MetricScoring {
  weight: number;
  /** Value that scores 0. */
  bad: number;
  /** Value that scores 100. May be lower than `bad` when lower is better (e.g. P/E). */
  good: number;
}

export interface StudyConfig {
  universe: string[];
  /** excludeSectors: sectors (as the data provider names them) that never qualify, e.g. banks for the Magic Formula. */
  screen: { rules: ScreenRule[]; onMissing: 'pass' | 'fail'; excludeSectors?: string[] };
  scoring: Partial<Record<MetricKey, MetricScoring>>;
  sentiment: { lookbackDays: number; maxArticles: number; halfLifeDays: number };
  combine: { fundamentalWeight: number; sentimentWeight: number };
  watchlist: { topN: number; minScore: number; minSentiment: number };
}

export interface StrategyConfig {
  /** Which strategy's rules to use (default emaTrend). The rest are emaTrend's settings; ATR settings are shared by all. */
  name?: StrategyName;
  fastEma: number;
  slowEma: number;
  trendEma: number;
  rsiPeriod: number;
  rsiMin: number;
  rsiMax: number;
  atrPeriod: number;
  stopAtr: number;
  trailAtr: number;
}

export interface RiskConfig {
  riskPerTrade: number;
  maxPositionPct: number;
  /** Cap on the combined market value of all positions, as a share of equity. */
  maxTotalExposurePct: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  maxOrderValue: number;
  /** Refuse entries when the live price is further than this from the latest candle close. */
  maxPriceDeviationPct: number;
}

export interface TradingConfig {
  strategy: StrategyConfig;
  risk: RiskConfig;
  engine: {
    evaluateAt: string;
    pollSeconds: number;
    watchlistMaxAgeDays: number;
    product: 'CNC';
    exchange: 'NSE' | 'BSE';
    stopLimitBufferPct: number;
    /** How long to wait for an order to reach a final state before treating it as unresolved. */
    orderTimeoutSeconds: number;
    /** How long a triggered-but-unfilled stop-limit may sit before the engine cancels it and exits at market. */
    triggeredStopGraceSeconds: number;
    holidays: string[];
  };
  backtest: {
    initialCapital: number;
    /** Flat per-side cost used for position sizing and the paper broker. */
    costPct: number;
    slippagePct: number;
    /** Itemised Indian delivery charges used by the backtests. */
    costs: CostSchedule;
  };
  /** Extra loss protection on top of every strategy (all optional; see protectionSettings). */
  protection?: Partial<ProtectionConfig>;
  /** The intraday desk (see trading/intraday.ts IntradayConfig; all optional). */
  intraday?: Partial<IntradayConfig>;
}

export interface ProtectionConfig {
  /** No new buys while the NIFTY 50 closes below its `marketSmaDays` average (a falling market). */
  marketFilter: boolean;
  marketSmaDays: number;
  /** No new buys while the account is this far below its highest value (0 = off). */
  drawdownBrakePct: number;
  /** At most this many companies from the same sector (0 = no limit). */
  maxPerSector: number;
}

export const DEFAULT_PROTECTION: ProtectionConfig = { marketFilter: true, marketSmaDays: 200, drawdownBrakePct: 0.1, maxPerSector: 3 };
export const protectionSettings = (cfg: Pick<TradingConfig, 'protection'>): ProtectionConfig => ({ ...DEFAULT_PROTECTION, ...(cfg.protection ?? {}) });

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const loadStudyConfig = () => loadJson<StudyConfig>(paths.studyConfig);
export function loadTradingConfig(path = paths.tradingConfig): TradingConfig {
  const cfg = loadJson<TradingConfig>(path);
  const errors = validateTradingConfig(cfg);
  const pr = protectionSettings(cfg);
  if (typeof pr.marketFilter !== 'boolean') errors.push('protection.marketFilter must be true or false');
  if (!Number.isInteger(pr.marketSmaDays) || pr.marketSmaDays < 20 || pr.marketSmaDays > 400) errors.push('protection.marketSmaDays must be a whole number from 20 to 400');
  if (!(pr.drawdownBrakePct >= 0 && pr.drawdownBrakePct <= 0.5)) errors.push('protection.drawdownBrakePct must be from 0 (off) to 0.5');
  if (!Number.isInteger(pr.maxPerSector) || pr.maxPerSector < 0 || pr.maxPerSector > 50) errors.push('protection.maxPerSector must be a whole number from 0 (no limit) to 50');
  const it = intradaySettings(cfg.intraday);
  if (typeof it.enabled !== 'boolean') errors.push('intraday.enabled must be true or false');
  if (!(it.allocationPct >= 0 && it.allocationPct <= 0.5)) errors.push('intraday.allocationPct must be from 0 to 0.5');
  if (!(it.riskPerTrade > 0 && it.riskPerTrade <= 0.02)) errors.push('intraday.riskPerTrade must be above 0 and at most 0.02');
  if (!(it.maxPositionPct > 0 && it.maxPositionPct <= 0.25)) errors.push('intraday.maxPositionPct must be above 0 and at most 0.25');
  if (!Number.isInteger(it.maxTradesPerDay) || it.maxTradesPerDay < 0 || it.maxTradesPerDay > 50) errors.push('intraday.maxTradesPerDay must be a whole number from 0 to 50');
  if (!(cfg.risk.maxTotalExposurePct + it.allocationPct <= 0.9 + 1e-9)) errors.push('risk.maxTotalExposurePct + intraday.allocationPct must not exceed 0.9 (90% of the money)');
  for (const k of ['lastEntry', 'squareOff'] as const) if (!/^\d{2}:\d{2}$/.test(it[k]) || it[k] > '15:20') errors.push(`intraday.${k} must be a time like 15:15, no later than 15:20`);
  if (errors.length) throw new Error(`Invalid ${path}:\n  - ${errors.join('\n  - ')}`);
  return cfg;
}

export interface Env {
  tradingMode: 'paper' | 'live';
  marketData: 'yahoo' | 'kite';
  paperCapital: number;
  kite: { apiKey?: string; apiSecret?: string; accessToken?: string };
}

export function loadEnv(): Env {
  const mode = process.env.TRADING_MODE ?? 'paper';
  if (mode !== 'paper' && mode !== 'live') throw new Error(`TRADING_MODE must be "paper" or "live", got "${mode}"`);
  const md = process.env.MARKET_DATA ?? 'yahoo';
  if (md !== 'yahoo' && md !== 'kite') throw new Error(`MARKET_DATA must be "yahoo" or "kite", got "${md}"`);
  const paperCapital = Number(process.env.PAPER_CAPITAL ?? 500000);
  if (!Number.isFinite(paperCapital) || paperCapital <= 0) throw new Error(`PAPER_CAPITAL must be a positive number, got "${process.env.PAPER_CAPITAL}"`);
  return {
    tradingMode: mode,
    marketData: md,
    paperCapital,
    kite: {
      apiKey: process.env.KITE_API_KEY || undefined,
      apiSecret: process.env.KITE_API_SECRET || undefined,
      accessToken: process.env.KITE_ACCESS_TOKEN || undefined,
    },
  };
}
