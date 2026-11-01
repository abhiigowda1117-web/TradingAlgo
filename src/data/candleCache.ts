import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Candle } from '../types';
import { readCandlesCsv } from './csv';

export function writeCandlesCsv(path: string, candles: Candle[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const rows = candles.map((c) => [c.time.toISOString(), c.open, c.high, c.low, c.close, c.volume].join(','));
  writeFileSync(path, ['date,open,high,low,close,volume', ...rows].join('\n') + '\n');
}

/**
 * Returns cached candles for `key` if the cache file is younger than `maxAgeHours`, otherwise
 * fetches, caches and returns them. Keeps repeated backtests from hitting Yahoo's rate limits.
 */
export async function cachedCandles(dir: string, key: string, fetch: () => Promise<Candle[]>, opts: { maxAgeHours?: number; refresh?: boolean } = {}): Promise<{ candles: Candle[]; fromCache: boolean }> {
  const path = join(dir, `${key.replace(/[^A-Za-z0-9_.&-]/g, '_')}.csv`);
  const fresh = existsSync(path) && Date.now() - statSync(path).mtimeMs < (opts.maxAgeHours ?? 24) * 3_600_000;
  if (fresh && !opts.refresh) return { candles: readCandlesCsv(path), fromCache: true };
  const candles = await fetch();
  writeCandlesCsv(path, candles);
  return { candles, fromCache: false };
}
