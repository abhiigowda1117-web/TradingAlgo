import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config';
import type { CompanyProfile } from './types';

export interface PeerConfig {
  groups: Record<string, string[]>;
  custom: Record<string, string[]>;
}

export const loadPeerConfig = (path = resolve(ROOT, 'config/peers.json')): PeerConfig => {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PeerConfig>;
  return { groups: raw.groups ?? {}, custom: raw.custom ?? {} };
};

/** Explicit list > custom entry > other members of the symbol's group(s). Empty when unknown. */
export function resolvePeers(symbol: string, cfg: PeerConfig, explicit?: string[]): { peers: string[]; basis: string } {
  const s = symbol.toUpperCase();
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toUpperCase()).filter((x) => x && x !== s))].slice(0, 6);
  if (explicit?.length) return { peers: clean(explicit), basis: 'chosen by you' };
  if (cfg.custom[s]?.length) return { peers: clean(cfg.custom[s]!), basis: 'config/peers.json (custom)' };
  const groups = Object.entries(cfg.groups).filter(([, members]) => members.map((m) => m.toUpperCase()).includes(s));
  if (groups.length) return { peers: clean(groups.flatMap(([, m]) => m)), basis: `config/peers.json group "${groups.map(([g]) => g).join(', ')}"` };
  return { peers: [], basis: 'none configured' };
}

export interface PeerRow {
  symbol: string;
  name: string | null;
  marketCap: number | null;
  revenueGrowth: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  debtToEquity: number | null;
  pe: number | null;
  pb: number | null;
  error?: string;
}

const v = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? null : x);

export function peerRow(p: CompanyProfile): PeerRow {
  const s = p.stats;
  return {
    symbol: p.symbol,
    name: p.name,
    marketCap: p.marketCap,
    revenueGrowth: v(s.revenueGrowth),
    operatingMargin: v(s.operatingMargins),
    netMargin: v(s.profitMargins),
    roe: v(s.returnOnEquity),
    debtToEquity: s.debtToEquity === undefined ? null : s.debtToEquity / 100,
    pe: v(s.trailingPE),
    pb: v(s.priceToBook),
  };
}

export function median(xs: (number | null)[]): number | null {
  const a = xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}
