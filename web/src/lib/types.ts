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
  brokerConfigured: boolean;
  strategy: Record<string, number>;
  risk: Record<string, number>;
  engine: Record<string, string | number>;
  capital: number;
}
