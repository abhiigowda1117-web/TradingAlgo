import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StudyConfig } from '../config';
import type { CompanyStudy } from './study';

export interface WatchlistEntry {
  symbol: string;
  name: string;
  sector?: string;
  combinedScore: number;
  fundamentalScore: number;
  sentiment: number;
}

export interface Watchlist {
  generatedAt: string;
  entries: WatchlistEntry[];
  rejected: { symbol: string; reason: string }[];
}

/** Picks the companies the trading engine may buy: passed the screen, decent news, top combined scores. */
export function buildWatchlist(studies: CompanyStudy[], cfg: StudyConfig['watchlist'], now: Date = new Date()): Watchlist {
  const rejected: Watchlist['rejected'] = [];
  const eligible = studies.filter((s) => {
    const failed = s.screen.results.filter((r) => !r.passed).map((r) => `${r.rule.metric} ${r.rule.op} ${r.rule.value}`);
    const reason = failed.length
      ? `failed screen: ${failed.join(', ')}`
      : s.sentiment.score < cfg.minSentiment
        ? `news sentiment ${s.sentiment.score.toFixed(2)} below ${cfg.minSentiment}`
        : s.combinedScore < cfg.minScore
          ? `score ${s.combinedScore} below ${cfg.minScore}`
          : undefined;
    if (reason) rejected.push({ symbol: s.symbol, reason });
    return !reason;
  });
  eligible.sort((a, b) => b.combinedScore - a.combinedScore);
  for (const s of eligible.slice(cfg.topN)) rejected.push({ symbol: s.symbol, reason: `outside top ${cfg.topN}` });
  return {
    generatedAt: now.toISOString(),
    entries: eligible.slice(0, cfg.topN).map((s) => ({
      symbol: s.symbol,
      name: s.fundamentals.name,
      sector: s.fundamentals.sector,
      combinedScore: s.combinedScore,
      fundamentalScore: s.fundamental.score,
      sentiment: Math.round(s.sentiment.score * 100) / 100,
    })),
    rejected,
  };
}

export function saveWatchlist(path: string, w: Watchlist): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(w, null, 2));
}

export function loadWatchlist(path: string): Watchlist | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Watchlist) : undefined;
}
