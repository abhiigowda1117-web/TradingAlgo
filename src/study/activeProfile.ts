import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isProfileId, type ProfileId } from './profiles';

/** The stock-picking style chosen on the website; the company study uses it to build the watchlist. */
export interface ActiveProfile {
  id: ProfileId;
  changedBy?: string;
  changedAt?: string;
  source: 'website' | 'default';
}

export function readActiveProfile(path: string | undefined): ActiveProfile {
  if (path && existsSync(path)) {
    try {
      const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<ActiveProfile>;
      if (isProfileId(v.id)) return { id: v.id, changedBy: v.changedBy, changedAt: v.changedAt, source: 'website' };
    } catch {
      /* unreadable: default */
    }
  }
  return { id: 'balanced', source: 'default' };
}

export function writeActiveProfile(path: string, id: ProfileId, by: string, now = new Date()): ActiveProfile {
  if (!isProfileId(id)) throw new Error('Unknown stock-picking style');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify({ id, changedBy: by, changedAt: now.toISOString() }));
  renameSync(`${path}.tmp`, path);
  return { id, changedBy: by, changedAt: now.toISOString(), source: 'website' };
}
