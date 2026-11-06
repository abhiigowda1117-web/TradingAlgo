import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Single-instance lock for the trading engine, plus a polite "please stop" request file.
 * Two engines on the same account would double-trade, so a second engine refuses to start while the
 * first is alive, whether it was started from a terminal or from the website. Plain files only: the
 * web server reads these without loading any trading or broker code.
 */

export interface LockInfo {
  pid: number;
  startedAt: string;
  startedBy: string;
  mode: 'paper' | 'live';
}

/** True when a process with this id exists (signal 0 checks without affecting it; works on Windows too). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

export function readLock(path: string): LockInfo | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    return Number.isInteger(v.pid) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The running engine, if any. A lock left behind by a crashed engine counts as not running. */
export function runningEngine(path: string): LockInfo | undefined {
  const l = readLock(path);
  return l && processAlive(l.pid) ? l : undefined;
}

/**
 * Takes the lock for this process. Returns the other engine's details instead if one is alive.
 * The lock is released automatically when this process exits.
 */
export function acquireLock(path: string, info: Omit<LockInfo, 'pid' | 'startedAt'>, pid = process.pid): { ok: true } | { ok: false; holder: LockInfo } {
  const holder = runningEngine(path);
  if (holder && holder.pid !== pid) return { ok: false, holder };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, startedAt: new Date().toISOString(), ...info } satisfies LockInfo));
  const release = () => {
    if (readLock(path)?.pid === pid) rmSync(path, { force: true });
  };
  process.once('exit', release);
  return { ok: true };
}

export function requestStop(path: string, by: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ requestedAt: new Date().toISOString(), by }));
}

export const stopRequested = (path: string) => existsSync(path);
export const clearStopRequest = (path: string) => rmSync(path, { force: true });
