import { readFileSync } from 'node:fs';

export interface Membership {
  symbol: string;
  from: string;
  /** Inclusive last day; undefined while still a member. */
  to?: string;
}

/**
 * Reads point-in-time index membership from a CSV with columns symbol,from,to (dates YYYY-MM-DD,
 * `to` empty for current members). A symbol may appear on several rows if it left and rejoined.
 */
export function readConstituents(path: string): Membership[] {
  const [header, ...rows] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = (header ?? '').split(',').map((c) => c.trim().toLowerCase());
  const [s, f, t] = ['symbol', 'from', 'to'].map((n) => cols.indexOf(n));
  if (s! < 0 || f! < 0 || t! < 0) throw new Error(`${path}: need symbol,from,to columns`);
  return rows
    .filter((r) => r.trim())
    .map((r, n) => {
      const x = r.split(',').map((v) => v.trim());
      const m = { symbol: x[s!]!.toUpperCase(), from: x[f!]!, to: x[t!] || undefined };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.from) || (m.to && !/^\d{4}-\d{2}-\d{2}$/.test(m.to))) throw new Error(`${path} row ${n + 2}: dates must be YYYY-MM-DD`);
      return m;
    });
}

export function membershipFilter(members: Membership[]): (symbol: string, day: string) => boolean {
  const bySymbol = new Map<string, Membership[]>();
  for (const m of members) bySymbol.set(m.symbol, [...(bySymbol.get(m.symbol) ?? []), m]);
  return (symbol, day) => (bySymbol.get(symbol) ?? []).some((m) => day >= m.from && (!m.to || day <= m.to));
}
