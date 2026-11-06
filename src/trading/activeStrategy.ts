import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_STRATEGY, isStrategyName, type StrategyName } from './strategyIds';

/**
 * Which strategy the engine uses for NEW buys, chosen on the website (paper trading). Stored in a small
 * file so the web server never loads trading code; the engine reads it at each daily evaluation.
 * Without the file, config/trading.json `strategy.name` (or emaTrend) applies.
 */
export interface ActiveStrategy {
  name: StrategyName;
  changedBy?: string;
  changedAt?: string;
  source: 'website' | 'config';
}

export function readActiveStrategy(path: string | undefined, fallback?: StrategyName): ActiveStrategy {
  if (path && existsSync(path)) {
    try {
      const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<ActiveStrategy>;
      if (isStrategyName(v.name)) return { name: v.name, changedBy: v.changedBy, changedAt: v.changedAt, source: 'website' };
    } catch {
      /* unreadable: fall back to the config */
    }
  }
  return { name: fallback ?? DEFAULT_STRATEGY, source: 'config' };
}

export function writeActiveStrategy(path: string, name: StrategyName, by: string, now = new Date()): ActiveStrategy {
  if (!isStrategyName(name)) throw new Error('Unknown strategy');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ name, changedBy: by, changedAt: now.toISOString() }));
  renameSync(tmp, path);
  return { name, changedBy: by, changedAt: now.toISOString(), source: 'website' };
}
