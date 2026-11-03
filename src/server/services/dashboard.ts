import { existsSync, readFileSync } from 'node:fs';
import type { TradingConfig } from '../../config';
import type { QuoteSnapshot } from '../../research/companyUpdate';
import { readEngineView, recentTrades, type EngineFiles, type EngineView } from './engineView';

/** Read-only data for the dashboard, assembled from the engine's files. No trading code runs here. */

export interface PricedPosition extends Omit<EngineView['positions'][number], never> {
  last: number | null;
  value: number | null;
  pnl: number | null;
}

export interface EngineStatus extends Omit<EngineView, 'positions'> {
  positions: PricedPosition[];
  equity: number | null;
  dayPnl: number | null;
  investedPct: number | null;
  priceError?: string;
  mode: 'paper' | 'live';
  /** False when the paper account file does not exist yet (no paper order placed); cash is then the starting capital. */
  paperAccountStarted: boolean;
}

export async function engineStatus(
  files: EngineFiles,
  opts: { now: Date; aliveWithinSeconds: number; mode: 'paper' | 'live'; quotes: (tickers: string[]) => Promise<QuoteSnapshot[]>; initialCash?: number },
): Promise<EngineStatus> {
  const view = readEngineView(files, opts.now, opts.aliveWithinSeconds);
  // The paper broker only writes its account file on its first order. Until then the account holds
  // exactly the configured starting capital, so show that rather than nothing.
  const paperAccountStarted = view.cash !== null;
  if (!paperAccountStarted && opts.mode === 'paper' && view.positions.length === 0 && opts.initialCash && opts.initialCash > 0) view.cash = opts.initialCash;
  let prices: Record<string, number> = {};
  let priceError: string | undefined;
  if (view.positions.length) {
    try {
      const qs = await opts.quotes(view.positions.map((p) => `${p.symbol}.NS`));
      prices = Object.fromEntries(qs.filter((q) => q.price !== null).map((q) => [q.ticker.replace(/\.NS$/, ''), q.price!]));
    } catch (e) {
      priceError = `Live prices unavailable: ${(e as Error).message}`;
    }
  }
  const positions: PricedPosition[] = view.positions.map((p) => {
    const last = prices[p.symbol] ?? null;
    return { ...p, last, value: last === null ? null : last * p.qty, pnl: last === null ? null : (last - p.entryPrice) * p.qty };
  });
  const allPriced = positions.every((p) => p.value !== null);
  const invested = allPriced ? positions.reduce((a, p) => a + p.value!, 0) : null;
  const equity = view.cash !== null && invested !== null ? view.cash + invested : null;
  return {
    ...view,
    positions,
    equity,
    dayPnl: equity !== null && view.dayStartEquity !== null ? equity - view.dayStartEquity : null,
    investedPct: equity && invested !== null ? invested / equity : null,
    priceError,
    mode: opts.mode,
    paperAccountStarted,
  };
}

export interface BacktestSummary {
  generatedAt: string;
  period: { from: string; to: string };
  strategyReturn: number | null;
  benchmarkReturn: number | null;
  benchmarkLabel: string;
  curve: { day: string; strategy: number; benchmark: number }[];
}

/** The latest saved portfolio backtest (npm run portfolio -- --json ...), condensed for charts. */
export function latestBacktest(path: string): BacktestSummary | null {
  if (!existsSync(path)) return null;
  try {
    const b = JSON.parse(readFileSync(path, 'utf8'));
    const full = b.periods?.[0];
    return {
      generatedAt: b.generatedAt,
      period: { from: b.period?.from, to: b.period?.to },
      strategyReturn: full?.strategy?.totalReturn ?? null,
      benchmarkReturn: full?.benchmark?.totalReturn ?? null,
      benchmarkLabel: b.benchmark?.label ?? 'NIFTY 50',
      curve: Array.isArray(b.curve) ? b.curve : [],
    };
  } catch {
    return null;
  }
}

export function dashboardTrades(files: EngineFiles, n: number) {
  return recentTrades(files.trades, n).map((t) => ({
    time: String(t.time ?? ''),
    symbol: String(t.symbol ?? ''),
    side: String(t.side ?? ''),
    qty: typeof t.qty === 'number' ? t.qty : null,
    price: typeof t.price === 'number' ? t.price : null,
    pnl: typeof t.pnl === 'number' ? t.pnl : null,
    reason: typeof t.reason === 'string' ? t.reason : null,
  }));
}

/** Non-secret settings for display. Broker keys/tokens are reported only as configured or not. */
export function settingsView(cfg: TradingConfig, env: NodeJS.ProcessEnv) {
  return {
    tradingMode: env.TRADING_MODE === 'live' ? 'live' : 'paper',
    marketData: env.MARKET_DATA === 'kite' ? 'kite' : 'yahoo',
    brokerConfigured: Boolean(env.KITE_API_KEY && env.KITE_ACCESS_TOKEN),
    strategy: cfg.strategy,
    risk: cfg.risk,
    engine: { evaluateAt: cfg.engine.evaluateAt, pollSeconds: cfg.engine.pollSeconds, exchange: cfg.engine.exchange, product: cfg.engine.product, watchlistMaxAgeDays: cfg.engine.watchlistMaxAgeDays },
    capital: cfg.backtest.initialCapital,
  };
}
