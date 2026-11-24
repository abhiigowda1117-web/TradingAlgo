import type { Candle } from '../types';
import { sma } from './indicators';
import { dayKey } from './portfolioBacktest';

/**
 * Market filter for backtests, matching the engine: buying is allowed on a day only when the index
 * closed at or above its `smaDays` average that day. Days without enough index history allow buying
 * (the filter cannot judge them); days missing from the index use the latest earlier close.
 */
export function marketOkFromIndex(index: Candle[], smaDays: number): (day: string) => boolean {
  const sorted = [...index].sort((a, b) => a.time.getTime() - b.time.getTime());
  const closes = sorted.map((c) => c.close);
  const avg = sma(closes, smaDays);
  const days = sorted.map((c) => dayKey(c.time));
  const ok = new Map(days.map((d, i) => [d, Number.isNaN(avg[i]!) ? true : closes[i]! >= avg[i]!]));
  return (day) => {
    if (ok.has(day)) return ok.get(day)!;
    let lo = 0;
    let hi = days.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid]! <= day) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? true : ok.get(days[found]!)!;
  };
}
