import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import type { EngineState } from '../../trading/engine';

/**
 * Read-only view of the paper-trading engine's files, for the web app. The only thing the web app
 * ever writes is the kill-switch file; it never imports or runs trading code.
 */
export interface EngineFiles {
  state: string;
  paperAccount: string;
  trades: string;
  engineLog: string;
  heartbeat: string;
  killSwitch: string;
  watchlist: string;
}

export type KillSwitchMode = 'off' | 'halt' | 'flatten';

function readJsonSafe<T>(path: string): { value?: T; error?: string } {
  if (!existsSync(path)) return {};
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as T };
  } catch (e) {
    return { error: `${path} could not be read: ${(e as Error).message}` };
  }
}

export function readKillSwitch(path: string): KillSwitchMode {
  if (!existsSync(path)) return 'off';
  try {
    return readFileSync(path, 'utf8').trim().toUpperCase() === 'FLATTEN' ? 'flatten' : 'halt';
  } catch {
    return 'halt';
  }
}

export function setKillSwitch(path: string, mode: KillSwitchMode): void {
  if (mode === 'off') rmSync(path, { force: true });
  else writeFileSync(path, mode === 'flatten' ? 'FLATTEN\n' : 'HALT\n');
}

/** Last `n` lines of a text file, reading at most the final 256 KB. */
export function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    return (size > len ? lines.slice(1) : lines).slice(-n);
  } finally {
    closeSync(fd);
  }
}

export function recentTrades(path: string, n: number): Record<string, unknown>[] {
  return tailLines(path, n)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .reverse();
}

export interface EngineView {
  heartbeat: { at: string; result: string; error?: string; broker?: string; ageSeconds: number; alive: boolean } | null;
  killSwitch: KillSwitchMode;
  cash: number | null;
  positions: {
    symbol: string;
    qty: number;
    entryPrice: number;
    entryDate: string;
    stop: number;
    protection: string;
    protectedStop?: number;
    exitReason?: string;
  }[];
  openOrders: { id: string; kind: string; side: string; qty: number; symbol: string; status: string; brokerStatus?: string }[];
  dayStartEquity: number | null;
  haltedOn: string | null;
  lastEvaluated: string | null;
  watchlist: { generatedAt: string; entries: { symbol: string; name: string; combinedScore: number; fundamentalScore: number; sentiment: number }[] } | null;
  errors: string[];
}

const FINAL = new Set(['complete', 'cancelled', 'rejected', 'not_found', 'expired']);

export function readEngineView(f: EngineFiles, now: Date, aliveWithinSeconds: number): EngineView {
  const errors: string[] = [];
  const st = readJsonSafe<EngineState>(f.state);
  const acct = readJsonSafe<{ cash: number }>(f.paperAccount);
  const hb = readJsonSafe<{ at: string; result: string; error?: string; broker?: string }>(f.heartbeat);
  const wl = readJsonSafe<EngineView['watchlist']>(f.watchlist);
  for (const r of [st, acct, hb, wl]) if (r.error) errors.push(r.error);
  const s = st.value;
  const age = hb.value ? (now.getTime() - new Date(hb.value.at).getTime()) / 1000 : null;
  return {
    heartbeat: hb.value && age !== null ? { ...hb.value, ageSeconds: Math.round(age), alive: age <= aliveWithinSeconds } : null,
    killSwitch: readKillSwitch(f.killSwitch),
    cash: typeof acct.value?.cash === 'number' ? acct.value.cash : null,
    positions: Object.values(s?.positions ?? {}).map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryDate: p.entryDate,
      stop: p.stop,
      protection: p.protection,
      protectedStop: p.protectedStop,
      exitReason: p.exitReason,
    })),
    openOrders: Object.values(s?.intents ?? {})
      .filter((i) => !FINAL.has(i.status))
      .map((i) => ({ id: i.id, kind: i.kind, side: i.side, qty: i.qty, symbol: i.symbol, status: i.status, brokerStatus: i.brokerStatus })),
    dayStartEquity: s?.dayStartEquity ?? null,
    haltedOn: s?.haltedOn ?? null,
    lastEvaluated: s?.lastEvaluated ?? null,
    watchlist: wl.value ?? null,
    errors,
  };
}
