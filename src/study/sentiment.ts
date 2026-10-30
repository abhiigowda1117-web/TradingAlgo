import type { NewsArticle } from '../types';

/**
 * Small finance-oriented lexicon (in the spirit of Loughran-McDonald) tuned for Indian
 * market headlines. Weights are -3..+3. Multi-word phrases are matched before single words.
 */
const LEXICON: Record<string, number> = {
  // positive
  surge: 2, surges: 2, soar: 3, soars: 3, jump: 2, jumps: 2, rally: 2, rallies: 2, gain: 1, gains: 1,
  rise: 1, rises: 1, climb: 1, climbs: 1, beat: 2, beats: 2, record: 1, upgrade: 2, upgraded: 2,
  outperform: 2, buy: 1, bullish: 2, profit: 1, growth: 1, strong: 1, robust: 2, expansion: 1,
  approval: 1, approves: 1, wins: 2, win: 1, bags: 2, order: 1, orders: 1, dividend: 1, bonus: 1,
  buyback: 2, 'all-time high': 2, '52-week high': 2, 'record high': 2, 'order win': 2, 'target price raised': 2,
  'net profit rises': 2, 'profit jumps': 3, 'beats estimates': 3, 'raises guidance': 3,
  // negative
  fall: -1, falls: -1, drop: -1, drops: -1, slump: -2, slumps: -2, plunge: -3, plunges: -3, crash: -3,
  tumble: -2, tumbles: -2, decline: -1, declines: -1, loss: -2, losses: -2, miss: -2, misses: -2,
  downgrade: -2, downgraded: -2, underperform: -2, sell: -1, bearish: -2, weak: -1, probe: -2,
  fraud: -3, penalty: -2, fine: -1, raid: -2, default: -3, lawsuit: -2, resigns: -2, resignation: -2,
  pledge: -1, ban: -2, scam: -3, warning: -1, cut: -1, cuts: -1, layoffs: -2, strike: -1,
  '52-week low': -2, 'net loss': -3, 'misses estimates': -3, 'cuts guidance': -3, 'target price cut': -2,
  'profit falls': -2, 'profit drops': -2, 'show cause': -2, 'sebi notice': -2,
};

const NEGATORS = new Set(['no', 'not', 'never', 'without', "isn't", "doesn't", "didn't", 'fails', 'failed']);
const PHRASES = Object.keys(LEXICON).filter((k) => k.includes(' ')).sort((a, b) => b.length - a.length);

/** Scores one headline in [-1, 1]. */
export function headlineSentiment(text: string): number {
  let s = ` ${text.toLowerCase().replace(/[^a-z0-9%\- ']/g, ' ')} `;
  let total = 0;
  for (const p of PHRASES) {
    while (s.includes(` ${p} `)) {
      total += LEXICON[p]!;
      s = s.replace(` ${p} `, ' ');
    }
  }
  // A negator flips the first sentiment word within the next 3 tokens, and only that one.
  let negateFor = 0;
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    if (NEGATORS.has(tok)) {
      negateFor = 3;
      continue;
    }
    if (Object.hasOwn(LEXICON, tok)) {
      const w = LEXICON[tok]!;
      total += negateFor > 0 ? -w : w;
      negateFor = 0;
    } else if (negateFor > 0) negateFor--;
  }
  return Math.tanh(total / 3);
}

export interface SentimentSummary {
  /** Recency-weighted mean in [-1, 1]; 0 when there is no news. */
  score: number;
  articles: number;
  scored: { article: NewsArticle; score: number }[];
}

/** Aggregates headline scores, weighting each by recency with the given half-life. */
export function aggregateSentiment(articles: NewsArticle[], halfLifeDays: number, now: Date = new Date()): SentimentSummary {
  const scored = articles.map((article) => ({ article, score: headlineSentiment(article.title) }));
  let num = 0;
  let den = 0;
  for (const { article, score } of scored) {
    const ageDays = Math.max(0, (now.getTime() - article.publishedAt.getTime()) / 86_400_000);
    const w = 0.5 ** (ageDays / halfLifeDays);
    num += w * score;
    den += w;
  }
  return { score: den > 0 ? num / den : 0, articles: articles.length, scored };
}
