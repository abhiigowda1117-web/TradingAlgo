/** Shapes returned by the AlgoTrade API (subset used by the UI). */

export interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryDate: string;
  stop: number;
  protection: string;
  protectedStop?: number;
  exitReason?: string;
  last: number | null;
  value: number | null;
  pnl: number | null;
}

export interface EngineStatus {
  heartbeat: { at: string; result: string; error?: string; broker?: string; ageSeconds: number; alive: boolean } | null;
  killSwitch: 'off' | 'halt' | 'flatten';
  cash: number | null;
  positions: Position[];
  openOrders: { id: string; kind: string; side: string; qty: number; symbol: string; status: string; brokerStatus?: string }[];
  dayStartEquity: number | null;
  haltedOn: string | null;
  lastEvaluated: string | null;
  equity: number | null;
  dayPnl: number | null;
  investedPct: number | null;
  priceError?: string;
  mode: 'paper' | 'live';
  paperAccountStarted: boolean;
  errors: string[];
}

export interface Trade {
  time: string;
  symbol: string;
  side: string;
  qty: number | null;
  price: number | null;
  pnl: number | null;
  reason: string | null;
}

export interface BacktestSummary {
  generatedAt: string;
  strategyName?: string;
  period: { from: string; to: string };
  strategyReturn: number | null;
  benchmarkReturn: number | null;
  benchmarkLabel: string;
  curve: { day: string; strategy: number; benchmark: number }[];
}

export interface DashboardSummary {
  engine: EngineStatus;
  trades: Trade[];
  backtest: BacktestSummary | null;
  watchlistCount: number;
}

export interface IndexRow {
  ticker: string;
  label: string;
  group: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  time: string | null;
}

export interface MarketOverview {
  source?: PriceSource;
  generatedAt: string;
  session: { open: boolean; label: string; istTime: string; holiday: boolean };
  indices: IndexRow[];
  stocks: { symbol: string; name: string | null; price: number | null; changePct: number | null; range52: number | null }[];
  breadth: { advancers: number; decliners: number; unchanged: number; unavailable: number } | null;
  summary: string[];
  dataNote: string;
}

export interface Watchlist {
  generatedAt: string | null;
  entries: { symbol: string; name: string; sector?: string; combinedScore: number; fundamentalScore: number; sentiment: number }[];
  rejected: { symbol: string; reason: string }[];
}

export interface Settings {
  tradingMode: 'paper' | 'live';
  marketData: string;
  webMarketData: string;
  brokerConfigured: boolean;
  strategy: Record<string, number>;
  risk: Record<string, number>;
  engine: Record<string, string | number>;
  capital: number;
}

export interface MoverRow {
  symbol: string;
  name: string | null;
  price: number;
  change: number | null;
  /** Percent units: 1.5 means +1.5%. */
  changePct: number;
}

/** Where a set of prices came from (Zerodha Kite or Yahoo Finance), and any reason Kite was not used. */
export interface PriceSource {
  provider: 'kite' | 'yahoo' | 'mixed';
  live: boolean;
  label: string;
  warning?: string;
}

export interface MarketMovers {
  source?: PriceSource;
  generatedAt: string;
  session: { open: boolean; label: string; istTime: string; holiday: boolean };
  gainers: MoverRow[];
  losers: MoverRow[];
  tape: MoverRow[];
  scanned: number;
  unavailable: number;
  quoteTime: string | null;
  dataNote: string;
}

export interface ManualOrderView {
  id: string;
  kind: 'buy' | 'sell';
  symbol: string;
  maxQty?: number;
  requestedBy: string;
  requestedAt: string;
  status: 'queued' | 'done' | 'rejected';
  message?: string;
  finishedAt?: string;
}

export interface JobView {
  job: 'study' | 'backtest' | 'lab';
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  startedBy: string;
  lines: string[];
}

/** GET /api/control: everything the control panels show. */
export interface ControlView {
  canControl: boolean;
  tradingMode: 'paper' | 'live';
  available: boolean;
  engine: {
    running: boolean;
    pid?: number;
    startedAt?: string;
    startedBy?: string;
    mode?: 'paper' | 'live';
    stopRequested: boolean;
    lastExit?: { at: string; code: number | null; lines: string[] };
  } | null;
  killSwitch: 'off' | 'halt' | 'flatten';
  market: { open: boolean; label: string; istTime: string; holiday: boolean };
  job: JobView | null;
  orders: ManualOrderView[];
  log: string[];
}

export interface StrategyInfo {
  id: 'emaTrend' | 'donchian' | 'momentum52' | 'rsi2' | 'supertrend';
  name: string;
  style: string;
  summary: string;
  buy: string;
  sell: string;
  suits: string;
}

export interface PerfSummary {
  label: string;
  from: string;
  to: string;
  days: number;
  startValue: number;
  endValue: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  trades?: number;
  winRate?: number;
  profitFactor?: number;
  exposure?: number;
}

export interface StrategyLab {
  generatedAt: string;
  period: { from: string; to: string; split: string; tradingDays: number };
  universe: { count: number; source: string; missing: string[] };
  benchmark: { label: string; kind: string; periods: PerfSummary[] };
  settings: { capital: number; maxOpenPositions: number; riskPerTrade: number; slippagePct: number };
  days: string[];
  benchmarkCurve: number[];
  strategies: { id: StrategyInfo['id']; name: string; periods: PerfSummary[]; liquidation: number; curve: number[] }[];
  survivorshipBias: boolean;
}

export interface StrategiesView {
  strategies: StrategyInfo[];
  active: { name: StrategyInfo['id']; changedBy?: string; changedAt?: string; source: 'website' | 'config' };
  lab: StrategyLab | null;
  canControl: boolean;
  tradingMode: 'paper' | 'live';
}
