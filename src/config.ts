import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  screen: { rules: ScreenRule[]; onMissing: 'pass' | 'fail' };
  scoring: Partial<Record<MetricKey, MetricScoring>>;
  sentiment: { lookbackDays: number; maxArticles: number; halfLifeDays: number };
  combine: { fundamentalWeight: number; sentimentWeight: number };
  watchlist: { topN: number; minScore: number; minSentiment: number };
}

export interface StrategyConfig {
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
  maxOpenPositions: number;
  maxDailyLossPct: number;
  maxOrderValue: number;
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
    holidays: string[];
  };
  backtest: { initialCapital: number; costPct: number; slippagePct: number };
}

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const loadStudyConfig = () => loadJson<StudyConfig>(paths.studyConfig);
export const loadTradingConfig = () => loadJson<TradingConfig>(paths.tradingConfig);

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
  return {
    tradingMode: mode,
    marketData: md,
    paperCapital: Number(process.env.PAPER_CAPITAL ?? 500000),
    kite: {
      apiKey: process.env.KITE_API_KEY || undefined,
      apiSecret: process.env.KITE_API_SECRET || undefined,
      accessToken: process.env.KITE_ACCESS_TOKEN || undefined,
    },
  };
}
