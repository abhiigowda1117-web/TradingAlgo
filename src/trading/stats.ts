/** Shared performance statistics for the single-symbol and portfolio backtests. */

export const yearsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / (365.25 * 86_400_000);

export function cagr(start: number, end: number, years: number): number {
  return years > 0 && start > 0 && end > 0 ? (end / start) ** (1 / years) - 1 : 0;
}

/** Largest peak-to-trough fall as a fraction of the peak. `start` is the value before the first point. */
export function maxDrawdown(values: number[], start = values[0] ?? 0): number {
  let peak = start;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return worst;
}

/** Period-over-period returns. `start` is the value before the first point. */
export function periodReturns(values: number[], start = values[0] ?? 0): number[] {
  const out: number[] = [];
  let prev = start;
  for (const v of values) {
    out.push(prev > 0 ? v / prev - 1 : 0);
    prev = v;
  }
  return out;
}

/** Annualised Sharpe ratio of daily returns, with a risk-free rate of zero unless given. */
export function sharpe(returns: number[], periodsPerYear = 252, riskFreeAnnual = 0): number {
  if (returns.length < 2) return 0;
  const rf = riskFreeAnnual / periodsPerYear;
  const excess = returns.map((r) => r - rf);
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const sd = Math.sqrt(excess.reduce((a, b) => a + (b - mean) ** 2, 0) / (excess.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;
}
