import type { MetricScoring, StudyConfig } from '../config';
import type { CompanyFundamentals, MetricKey } from '../types';

export interface MetricScore {
  metric: MetricKey;
  value: number | undefined;
  score: number | undefined;
  weight: number;
}

export interface FundamentalScore {
  /** 0-100, weighted over the metrics that were available. */
  score: number;
  /** Share of total weight backed by real data (0-1). Low coverage means a less reliable score. */
  coverage: number;
  breakdown: MetricScore[];
}

/** Linear 0-100 between `bad` and `good`, clamped. Works in either direction. */
export function scoreMetric(value: number, s: MetricScoring): number {
  if (s.good === s.bad) return value >= s.good ? 100 : 0;
  const t = (value - s.bad) / (s.good - s.bad);
  return Math.round(Math.min(1, Math.max(0, t)) * 100);
}

export function fundamentalScore(f: CompanyFundamentals, scoring: StudyConfig['scoring']): FundamentalScore {
  const breakdown: MetricScore[] = [];
  let weighted = 0;
  let usedWeight = 0;
  let totalWeight = 0;
  for (const [metric, s] of Object.entries(scoring) as [MetricKey, MetricScoring][]) {
    const value = f[metric];
    totalWeight += s.weight;
    let score: number | undefined;
    if (value !== undefined) {
      // A negative P/E means the company is loss-making: worst possible valuation score.
      score = metric === 'pe' && value <= 0 ? 0 : scoreMetric(value, s);
      weighted += score * s.weight;
      usedWeight += s.weight;
    }
    breakdown.push({ metric, value, score, weight: s.weight });
  }
  return {
    score: usedWeight > 0 ? Math.round((weighted / usedWeight) * 10) / 10 : 0,
    coverage: totalWeight > 0 ? usedWeight / totalWeight : 0,
    breakdown,
  };
}
