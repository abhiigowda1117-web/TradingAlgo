import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Manual paper orders requested from the website. The web server only writes a request file into
 * `<dir>/inbox`; the running engine picks it up on its next tick, applies every risk rule, and writes
 * the outcome to `<dir>/done`. The web server never talks to a broker. Paper trading only: the engine
 * rejects these requests when it runs with a live broker.
 */

export type ManualKind = 'buy' | 'sell';
export type ManualStatus = 'queued' | 'done' | 'rejected';

export interface ManualOrder {
  id: string;
  kind: ManualKind;
  symbol: string;
  /** Buy only: upper limit on quantity. The risk rules may allow fewer shares, never more. */
  maxQty?: number;
  requestedBy: string;
  requestedAt: string;
  status: ManualStatus;
  message?: string;
  finishedAt?: string;
}

export const SYMBOL = /^[A-Z0-9&-]{1,20}$/;

const inbox = (dir: string) => join(dir, 'inbox');
const done = (dir: string) => join(dir, 'done');
const safeName = (id: string) => /^[A-Za-z0-9-]{1,64}$/.test(id);

/** Writes a request atomically (temp file + rename) so the engine never reads half a file. */
export function queueManualOrder(dir: string, o: { kind: ManualKind; symbol: string; maxQty?: number; requestedBy: string }, now = new Date()): ManualOrder {
  const symbol = o.symbol.trim().toUpperCase();
  if (!SYMBOL.test(symbol)) throw new Error('Enter an NSE symbol such as RELIANCE or TCS');
  if (o.maxQty !== undefined && !(Number.isInteger(o.maxQty) && o.maxQty > 0 && o.maxQty <= 100_000)) throw new Error('Quantity must be a whole number from 1 to 100000');
  const order: ManualOrder = {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: o.kind,
    symbol,
    ...(o.maxQty !== undefined ? { maxQty: o.maxQty } : {}),
    requestedBy: o.requestedBy,
    requestedAt: now.toISOString(),
    status: 'queued',
  };
  mkdirSync(inbox(dir), { recursive: true });
  const tmp = join(inbox(dir), `.${order.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(order));
  renameSync(tmp, join(inbox(dir), `${order.id}.json`));
  return order;
}

function readDir(path: string): ManualOrder[] {
  if (!existsSync(path)) return [];
  const out: ManualOrder[] = [];
  for (const f of readdirSync(path)) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(path, f), 'utf8')) as ManualOrder);
    } catch {
      /* a file being written right now; picked up next time */
    }
  }
  return out;
}

/**
 * Waiting requests, oldest first (for the engine). A request that already has an outcome (the engine
 * stopped between recording it and removing the request) is dropped, never run twice.
 */
export function pendingManualOrders(dir: string): ManualOrder[] {
  const out: ManualOrder[] = [];
  for (const o of readDir(inbox(dir))) {
    if (!safeName(o.id)) continue;
    if (existsSync(join(done(dir), `${o.id}.json`))) rmSync(join(inbox(dir), `${o.id}.json`), { force: true });
    else out.push(o);
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** Records the outcome and removes the request from the inbox. Done first, so a crash in between cannot run it twice. */
export function finishManualOrder(dir: string, o: ManualOrder, status: Exclude<ManualStatus, 'queued'>, message: string, now = new Date()) {
  if (!safeName(o.id)) return;
  mkdirSync(done(dir), { recursive: true });
  writeFileSync(join(done(dir), `${o.id}.json`), JSON.stringify({ ...o, status, message, finishedAt: now.toISOString() } satisfies ManualOrder));
  rmSync(join(inbox(dir), `${o.id}.json`), { force: true });
}

/** Recent requests and outcomes, newest first (for the website). */
export function listManualOrders(dir: string, limit = 30): ManualOrder[] {
  const finished = readDir(done(dir));
  const seen = new Set(finished.map((o) => o.id));
  return [...readDir(inbox(dir)).filter((o) => !seen.has(o.id)), ...finished].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, limit);
}
