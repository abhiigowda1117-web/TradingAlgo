import { describe, expect, it } from 'vitest';
import type { StudyConfig } from '../src/config';
import { parseGoogleNewsRss } from '../src/data/googleNews';
import { mapQuoteSummary } from '../src/data/yahoo';
import { companyReport, summaryReport } from '../src/study/report';
import { fundamentalScore, scoreMetric } from '../src/study/scoring';
import { screen } from '../src/study/screener';
import { aggregateSentiment, headlineSentiment } from '../src/study/sentiment';
import { combineScores, newsQueryName, studyCompany } from '../src/study/study';
import { buildWatchlist } from '../src/study/watchlist';
import type { CompanyFundamentals, NewsArticle } from '../src/types';
import { FakeMarket, syntheticCandles, tradingCfg } from './helpers';

const studyCfg: StudyConfig = {
  universe: [],
  screen: {
    onMissing: 'pass',
    rules: [
      { metric: 'roe', op: '>=', value: 0.1 },
      { metric: 'debtToEquity', op: '<=', value: 1.5 },
    ],
  },
  scoring: {
    roe: { weight: 50, bad: 0.05, good: 0.25 },
    pe: { weight: 50, bad: 60, good: 12 },
  },
  sentiment: { lookbackDays: 14, maxArticles: 25, halfLifeDays: 5 },
  combine: { fundamentalWeight: 0.75, sentimentWeight: 0.25 },
  watchlist: { topN: 2, minScore: 50, minSentiment: -0.25 },
};

const good: CompanyFundamentals = { symbol: 'GOOD', name: 'Good Industries Limited', roe: 0.25, pe: 12, debtToEquity: 0.1, marketCap: 5e11 };
const ok: CompanyFundamentals = { symbol: 'OK', name: 'Okay Ltd', roe: 0.15, pe: 36 };
const levered: CompanyFundamentals = { symbol: 'DEBT', name: 'Debt Corp', roe: 0.3, pe: 10, debtToEquity: 3 };
const lossy: CompanyFundamentals = { symbol: 'LOSS', name: 'Loss Co', roe: 0.12, pe: -5 };

describe('scoring', () => {
  it('scores linearly and clamps, in either direction', () => {
    expect(scoreMetric(0.15, { weight: 1, bad: 0.05, good: 0.25 })).toBe(50);
    expect(scoreMetric(0.5, { weight: 1, bad: 0.05, good: 0.25 })).toBe(100);
    expect(scoreMetric(36, { weight: 1, bad: 60, good: 12 })).toBe(50);
    expect(scoreMetric(80, { weight: 1, bad: 60, good: 12 })).toBe(0);
  });

  it('weights metrics and renormalises over available data', () => {
    expect(fundamentalScore(good, studyCfg.scoring)).toMatchObject({ score: 100, coverage: 1 });
    expect(fundamentalScore(ok, studyCfg.scoring).score).toBe(50);
    expect(fundamentalScore({ symbol: 'X', name: 'X', roe: 0.25 }, studyCfg.scoring)).toMatchObject({ score: 100, coverage: 0.5 });
  });

  it('gives loss-making companies a zero valuation score', () => {
    const b = fundamentalScore(lossy, studyCfg.scoring).breakdown.find((m) => m.metric === 'pe');
    expect(b?.score).toBe(0);
  });
});

describe('screener', () => {
  it('passes, fails and treats missing data per config', () => {
    expect(screen(good, studyCfg.screen).passed).toBe(true);
    expect(screen(levered, studyCfg.screen).passed).toBe(false);
    expect(screen(ok, studyCfg.screen).passed).toBe(true);
    expect(screen(ok, { ...studyCfg.screen, onMissing: 'fail' }).passed).toBe(false);
  });
});

describe('sentiment', () => {
  it('reads direction from headlines', () => {
    expect(headlineSentiment('Infosys shares surge after Q2 profit beats estimates')).toBeGreaterThan(0.5);
    expect(headlineSentiment('Company faces SEBI notice, stock plunges to 52-week low')).toBeLessThan(-0.5);
    expect(headlineSentiment('Company to hold board meeting on Friday')).toBe(0);
  });

  it('handles negation and ignores object prototype keys', () => {
    expect(headlineSentiment('Shares did not fall despite weak market')).toBe(0);
    expect(headlineSentiment('Company not profitable')).toBe(0);
    expect(headlineSentiment('Stock does not surge')).toBeLessThan(0);
    expect(headlineSentiment('constructor toString valueOf')).toBe(0);
  });

  it('weights recent articles more', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    const a = (title: string, daysAgo: number): NewsArticle => ({ title, link: '', publishedAt: new Date(now.getTime() - daysAgo * 86_400_000) });
    const s = aggregateSentiment([a('Stock surges to record high', 0), a('Stock plunges', 10)], 5, now);
    expect(s.score).toBeGreaterThan(0.3);
    expect(aggregateSentiment([], 5, now).score).toBe(0);
  });
});

describe('data mapping', () => {
  it('maps Yahoo quoteSummary, converting debt/equity from percent', () => {
    const f = mapQuoteSummary('INFY', {
      financialData: { returnOnEquity: 0.31, debtToEquity: 9.5, revenueGrowth: 0.05, currentPrice: 1500, profitMargins: 0.17 },
      summaryDetail: { trailingPE: 24.1, dividendYield: 0.028 },
      defaultKeyStatistics: { priceToBook: { raw: 7.2 } },
      price: { longName: 'Infosys Limited', marketCap: 6.2e12 },
      assetProfile: { sector: 'Technology' },
    });
    expect(f).toMatchObject({ name: 'Infosys Limited', roe: 0.31, debtToEquity: 0.095, pe: 24.1, pb: 7.2, marketCap: 6.2e12, sector: 'Technology', price: 1500 });
    expect(f.earningsGrowth).toBeUndefined();
  });

  it('parses Google News RSS and strips the source suffix', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>TCS wins large deal - Economic Times</title><link>https://x/1</link><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate><source url="https://et">Economic Times</source></item>
      <item><title>Broken item</title><pubDate>not a date</pubDate></item>
    </channel></rss>`;
    const items = parseGoogleNewsRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'TCS wins large deal', source: 'Economic Times', link: 'https://x/1' });
  });

  it('builds clean news queries', () => {
    expect(newsQueryName('Infosys Limited')).toBe('Infosys');
    expect(newsQueryName('Tata Consultancy Services Ltd.')).toBe('Tata Consultancy Services');
  });
});

describe('study pipeline', () => {
  const now = new Date('2026-10-30T10:00:00Z');
  const fundamentals = { getFundamentals: async (s: string) => [good, ok, levered, lossy].find((f) => f.symbol === s)! };
  const news = {
    getNews: async (q: string): Promise<NewsArticle[]> =>
      q.includes('Okay') ? [{ title: 'Okay Ltd shares plunge after fraud probe', link: 'l', publishedAt: now }] : [],
  };

  it('studies, ranks and picks the watchlist the trading engine will use', async () => {
    const studies = await Promise.all(['GOOD', 'OK', 'DEBT', 'LOSS'].map((s) => studyCompany(s, { fundamentals, news }, studyCfg, tradingCfg.strategy, now)));
    const w = buildWatchlist(studies, studyCfg.watchlist, now);
    expect(w.entries.map((e) => e.symbol)).toEqual(['GOOD']);
    const reasons = Object.fromEntries(w.rejected.map((r) => [r.symbol, r.reason]));
    expect(reasons.DEBT).toMatch(/failed screen: debtToEquity/);
    expect(reasons.OK).toMatch(/news sentiment/);
    expect(reasons.LOSS).toMatch(/score .* below 50/);
    expect(w.generatedAt).toBe(now.toISOString());
  });

  it('combines fundamentals and sentiment', () => {
    expect(combineScores(100, 0, studyCfg.combine)).toBe(87.5);
    expect(combineScores(60, 1, studyCfg.combine)).toBe(70);
  });

  it('writes readable reports, including a technical snapshot', async () => {
    const market = new FakeMarket({ GOOD: syntheticCandles(300) });
    const s = await studyCompany('GOOD', { fundamentals, news, market }, studyCfg, tradingCfg.strategy, now);
    const w = buildWatchlist([s], studyCfg.watchlist, now);
    const md = companyReport(s, w, now);
    expect(md).toContain('# Good Industries Limited (GOOD)');
    expect(md).toContain('On the watchlist');
    expect(md).toContain('| Return on equity | 25.0% | 100 | 50 |');
    expect(md).toContain('## Technical snapshot');
    expect(summaryReport([s], w, now)).toContain('| 1 | [GOOD](./GOOD.md) |');
  });
});
