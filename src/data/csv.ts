import { readFileSync } from 'node:fs';
import type { Candle } from '../types';

/**
 * Reads daily candles from a CSV with a header row containing date, open, high, low, close
 * and optionally volume (case-insensitive, any column order). Rows are sorted by date.
 */
export function readCandlesCsv(path: string): Candle[] {
  const [header, ...rows] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  if (!header) return [];
  const cols = header.split(',').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => cols.findIndex((c) => c === name || (name === 'date' && (c === 'time' || c === 'timestamp')));
  const [d, o, h, l, c, v] = ['date', 'open', 'high', 'low', 'close', 'volume'].map(idx);
  if ([d, o, h, l, c].some((i) => i === undefined || i < 0)) throw new Error(`${path}: need date,open,high,low,close columns`);
  return rows
    .filter((r) => r.trim())
    .map((r) => {
      const f = r.split(',');
      return {
        time: new Date(f[d!]!),
        open: Number(f[o!]),
        high: Number(f[h!]),
        low: Number(f[l!]),
        close: Number(f[c!]),
        volume: v !== undefined && v >= 0 ? Number(f[v]) : 0,
      };
    })
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}
