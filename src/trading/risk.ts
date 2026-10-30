import type { RiskConfig } from '../config';

export interface SizingInput {
  equity: number;
  cash: number;
  price: number;
  stop: number;
}

export type SizingResult = { qty: number; reason: string };

/**
 * Fixed-fractional sizing: lose at most `riskPerTrade` of equity if the stop is hit,
 * capped by position size, the per-order value limit and available cash. Whole shares only.
 */
export function positionSize({ equity, cash, price, stop }: SizingInput, cfg: RiskConfig): SizingResult {
  const perShareRisk = price - stop;
  if (!(price > 0) || !(perShareRisk > 0)) return { qty: 0, reason: 'stop must be below price' };
  const caps = {
    risk: Math.floor((equity * cfg.riskPerTrade) / perShareRisk),
    'position size': Math.floor((equity * cfg.maxPositionPct) / price),
    'order value': Math.floor(cfg.maxOrderValue / price),
    cash: Math.floor(cash / price),
  };
  const [binding, qty] = Object.entries(caps).reduce((a, b) => (b[1] < a[1] ? b : a));
  if (qty < 1) return { qty: 0, reason: `${binding} limit allows less than 1 share` };
  return { qty, reason: `sized by ${binding} limit` };
}

export function dailyLossBreached(dayStartEquity: number, equity: number, cfg: RiskConfig): boolean {
  return dayStartEquity > 0 && (dayStartEquity - equity) / dayStartEquity >= cfg.maxDailyLossPct;
}
