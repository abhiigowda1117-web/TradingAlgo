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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parses YYYY-MM-DD, ISO timestamps, or "DD-Mon-YYYY" / "DD Mon YYYY" (as in NSE index downloads) to a UTC date. */
export function parseDay(raw: string): Date {
  const s = raw.trim().replace(/^"|"$/g, '');
  const m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS.indexOf(m[2]!.toLowerCase());
    if (mon < 0) throw new Error(`Unknown month in date "${raw}"`);
    return new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Unrecognised date "${raw}"`);
  return d;
}

/**
 * Reads a date + value series (e.g. a NIFTY 50 TRI download from niftyindices.com) as close-only
 * candles. The value column is the one named `valueColumn`, else the first of close /
 * "total returns index" / tri / value.
 */
export function readSeriesCsv(path: string, valueColumn?: string): Candle[] {
  const [header, ...rows] = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const split = (line: string) => (line.match(/("([^"]*)"|[^,]*)(,|$)/g) ?? []).map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').trim());
  const cols = split(header ?? '').map((c) => c.toLowerCase());
  const d = cols.findIndex((c) => c === 'date' || c === 'time' || c === 'timestamp');
  const wanted = valueColumn ? [valueColumn.toLowerCase()] : ['close', 'total returns index', 'tri', 'value'];
  const v = cols.findIndex((c) => wanted.includes(c));
  if (d < 0 || v < 0) throw new Error(`${path}: need a date column and one of ${wanted.join(' / ')} (found ${cols.join(', ')})`);
  return rows
    .filter((r) => r.trim())
    .map((r) => {
      const f = split(r);
      const close = Number(f[v]!.replace(/,/g, ''));
      if (!(close > 0)) throw new Error(`${path}: invalid value "${f[v]}"`);
      return { time: parseDay(f[d]!), open: close, high: close, low: close, close, volume: 0 };
    })
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}
