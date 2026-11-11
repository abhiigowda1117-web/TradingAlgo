import type { StudyConfig, StrategyConfig } from '../config';
import type { FundamentalsProvider, MarketData, NewsProvider } from '../data/types';
import { computeIndicators, entrySignal } from '../trading/strategy';
import type { Candle, CompanyFundamentals } from '../types';
import { fundamentalScore, type FundamentalScore } from './scoring';
import { screen, type ScreenResult } from './screener';
import { aggregateSentiment, type SentimentSummary } from './sentiment';
import { withDerivedMetrics } from './derived';

export interface TechnicalSnapshot {
  close: number;
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  rsi: number;
  atr: number;
  aboveTrend: boolean;
  signal: string;
}

export interface CompanyStudy {
  symbol: string;
  fundamentals: CompanyFundamentals;
  screen: ScreenResult;
  fundamental: FundamentalScore;
  sentiment: SentimentSummary;
  /** 0-100 combination of fundamental score and news sentiment. */
  combinedScore: number;
  technical?: TechnicalSnapshot;
  warnings: string[];
}

export interface StudyDeps {
  fundamentals: FundamentalsProvider;
  news?: NewsProvider;
  market?: MarketData;
}

/** "Infosys Limited" -> "Infosys"; used to build news queries. */
export function newsQueryName(name: string): string {
  return name.replace(/\b(limited|ltd\.?|corporation|corp\.?|company|co\.?|inc\.?)\s*$/i, '').trim();
}

export function combineScores(fundamental: number, sentiment: number, cfg: StudyConfig['combine']): number {
  const sentiment100 = (sentiment + 1) * 50;
  const w = cfg.fundamentalWeight + cfg.sentimentWeight;
  return Math.round(((fundamental * cfg.fundamentalWeight + sentiment100 * cfg.sentimentWeight) / w) * 10) / 10;
}

export function technicalSnapshot(candles: Candle[], cfg: StrategyConfig): TechnicalSnapshot | undefined {
  const i = candles.length - 1;
  if (i < 0) return undefined;
  const ind = computeIndicators(candles, cfg);
  const e = entrySignal(candles, ind, i, cfg);
  return {
    close: candles[i]!.close,
    emaFast: ind.fast[i]!,
    emaSlow: ind.slow[i]!,
    emaTrend: ind.trend[i]!,
    rsi: ind.rsi[i]!,
    atr: ind.atr[i]!,
    aboveTrend: candles[i]!.close > ind.trend[i]!,
    signal: e.enter ? `BUY: ${e.reason}` : `No entry: ${e.reason}`,
  };
}

export async function studyCompany(
  symbol: string,
  deps: StudyDeps,
  cfg: StudyConfig,
  strategy: StrategyConfig,
  now: Date = new Date(),
): Promise<CompanyStudy> {
  const warnings: string[] = [];
  const fundamentals = withDerivedMetrics(await deps.fundamentals.getFundamentals(symbol));
  const fund = fundamentalScore(fundamentals, cfg.scoring);
  if (fund.coverage < 0.6) warnings.push(`Only ${(fund.coverage * 100).toFixed(0)}% of scoring metrics available`);

  let sentiment: SentimentSummary = { score: 0, articles: 0, scored: [] };
  if (deps.news) {
    try {
      const since = new Date(now.getTime() - cfg.sentiment.lookbackDays * 86_400_000);
      const articles = await deps.news.getNews(`"${newsQueryName(fundamentals.name)}" share`, since, cfg.sentiment.maxArticles);
      sentiment = aggregateSentiment(articles, cfg.sentiment.halfLifeDays, now);
      if (articles.length === 0) warnings.push('No recent news found; sentiment treated as neutral');
    } catch (e) {
      warnings.push(`News unavailable: ${(e as Error).message}`);
    }
  }

  let technical: TechnicalSnapshot | undefined;
  if (deps.market) {
    try {
      const from = new Date(now.getTime() - 450 * 86_400_000);
      technical = technicalSnapshot(await deps.market.getDailyCandles(symbol, from, now), strategy);
    } catch (e) {
      warnings.push(`Price history unavailable: ${(e as Error).message}`);
    }
  }

  return {
    symbol,
    fundamentals,
    screen: screen(fundamentals, cfg.screen),
    fundamental: fund,
    sentiment,
    combinedScore: combineScores(fund.score, sentiment.score, cfg.combine),
    technical,
    warnings,
  };
}
