import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StrategyName } from './trading/strategyIds';
import type { CostSchedule } from './trading/costs';
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
}

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const loadStudyConfig = () => loadJson<StudyConfig>(paths.studyConfig);
export function loadTradingConfig(path = paths.tradingConfig): TradingConfig {
  const cfg = loadJson<TradingConfig>(path);
  const errors = validateTradingConfig(cfg);
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
