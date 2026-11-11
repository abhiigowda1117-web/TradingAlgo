import type { StudyConfig } from '../config';

/**
 * Stock-picking styles: which companies may go on the watchlist, modelled on well-known investors'
 * published principles. None of these investors published exact formulas for every point; each style
 * lists the source of its rules and what the free data cannot check. Ratios are fractions (0.15 = 15%),
 * debt/equity is a ratio (0.5), market cap is in rupees.
 */

export const PROFILE_IDS = ['balanced', 'buffett', 'graham', 'greenblatt', 'lynch', 'jhunjhunwala', 'qglp', 'oneil'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];
export const isProfileId = (v: unknown): v is ProfileId => typeof v === 'string' && (PROFILE_IDS as readonly string[]).includes(v);

export interface ProfileInfo {
  id: ProfileId;
  name: string;
  investor: string;
  summary: string;
  /** The rules in plain words. */
  picks: string[];
  /** Where the rules come from, and what could not be modelled with free data. */
  source: string;
  limits: string;
  /** Timing strategy that suits this style (Strategy Lab). */
  pairsWith: string;
}

export interface Profile extends ProfileInfo {
  /** Null: use config/study.json as it is (the original balanced score). */
  screen: StudyConfig['screen'] | null;
  scoring: StudyConfig['scoring'] | null;
}

const CR = 1e7; // one crore rupees

const PROFILES: Record<ProfileId, Profile> = {
  balanced: {
    id: 'balanced',
    name: 'Balanced (default)',
    investor: 'AlgoTrade',
    summary: 'The original mix: profitable, not over-indebted large caps, scored on returns, growth, margins and valuation, plus recent news tone.',
    picks: ['Market cap at least ₹10,000 cr, ROE at least 10%, debt/equity at most 1.5, profitable', 'Scored on ROE, growth, debt, margins, P/E, P/B, liquidity and dividends'],
    source: 'config/study.json (you can edit it).',
    limits: 'A general-purpose screen, not one investor\'s method.',
    pairsWith: 'EMA Trend',
    screen: null,
    scoring: null,
  },

  buffett: {
    id: 'buffett',
    name: 'Quality at a fair price',
    investor: 'Warren Buffett',
    summary: 'Wonderful businesses at sensible prices: high, durable returns on capital, little debt, strong margins and real cash generation.',
    picks: ['Return on equity at least 15%', 'Debt/equity at most 0.5', 'Net margin at least 10% and operating margin at least 15%', 'Positive free cash flow', 'P/E at most 35 (a "fair price" for Indian large caps)'],
    source:
      'Buffett\'s letters ("a wonderful company at a fair price") and the study "Buffett\'s Alpha" (Frazzini, Kabiller & Pedersen, Financial Analysts Journal 2018), which found his record is explained by buying cheap, safe, high-quality stocks.',
    limits: 'Moat, management quality and the long-term record cannot be read from one year of free data; the study also notes Buffett used about 1.6x leverage, which this does not.',
    pairsWith: 'Buy right, sit tight',
    screen: {
      onMissing: 'fail',
      rules: [
        { metric: 'roe', op: '>=', value: 0.15 },
        { metric: 'debtToEquity', op: '<=', value: 0.5 },
        { metric: 'profitMargin', op: '>=', value: 0.1 },
        { metric: 'operatingMargin', op: '>=', value: 0.15 },
        { metric: 'freeCashflow', op: '>', value: 0 },
        { metric: 'pe', op: '>', value: 0 },
        { metric: 'pe', op: '<=', value: 35 },
      ],
    },
    scoring: {
      roe: { weight: 25, bad: 0.12, good: 0.3 },
      operatingMargin: { weight: 15, bad: 0.1, good: 0.35 },
      debtToEquity: { weight: 15, bad: 1, good: 0 },
      profitMargin: { weight: 10, bad: 0.05, good: 0.25 },
      pe: { weight: 15, bad: 45, good: 15 },
      earningsGrowth: { weight: 10, bad: 0, good: 0.2 },
      currentRatio: { weight: 5, bad: 0.8, good: 2 },
      dividendYield: { weight: 5, bad: 0, good: 0.03 },
    },
  },

  graham: {
    id: 'graham',
    name: 'Defensive value',
    investor: 'Benjamin Graham',
    summary: 'The "defensive investor" rules from The Intelligent Investor: large, financially strong companies at low prices relative to earnings and assets.',
    picks: ['P/E between 0 and 15', 'P/E × P/B at most 22.5', 'Current ratio at least 2', 'Debt/equity at most 0.5', 'Pays a dividend', 'Market cap at least ₹5,000 cr'],
    source: 'Benjamin Graham, The Intelligent Investor, chapter 14 (stock selection for the defensive investor).',
    limits:
      'Graham also required 20 years of dividends, 10 years of profits and about a third more earnings over 10 years, and used 3-year average earnings; free data covers only recent figures. Very strict: often few or no Indian large caps qualify.',
    pairsWith: 'Buy right, sit tight',
    screen: {
      onMissing: 'fail',
      rules: [
        { metric: 'pe', op: '>', value: 0 },
        { metric: 'pe', op: '<=', value: 15 },
        { metric: 'peTimesPb', op: '<=', value: 22.5 },
        { metric: 'currentRatio', op: '>=', value: 2 },
        { metric: 'debtToEquity', op: '<=', value: 0.5 },
        { metric: 'dividendYield', op: '>', value: 0 },
        { metric: 'marketCap', op: '>=', value: 5000 * CR },
      ],
    },
    scoring: {
      pe: { weight: 30, bad: 20, good: 8 },
      peTimesPb: { weight: 25, bad: 30, good: 10 },
      currentRatio: { weight: 15, bad: 1.5, good: 3 },
      debtToEquity: { weight: 15, bad: 1, good: 0 },
      dividendYield: { weight: 15, bad: 0, good: 0.04 },
    },
  },

  greenblatt: {
    id: 'greenblatt',
    name: 'Magic Formula',
    investor: 'Joel Greenblatt',
    summary: 'Good companies at cheap prices: rank stocks by how cheap they are (earnings yield) and how profitable their capital is, and buy the best combined.',
    picks: ['Profitable, market cap at least ₹5,000 cr', 'Banks, insurers and utilities excluded (as in the book)', 'Scored half on earnings yield, half on return on assets'],
    source: 'Joel Greenblatt, The Little Book That Beats the Market (rank on earnings yield and return on capital, hold a portfolio of the top names).',
    limits: 'Uses 1/P/E instead of EBIT/enterprise value, and return on assets instead of return on capital, because the free data has neither; the book suggests ROA as a stand-in.',
    pairsWith: 'Buy right, sit tight',
    screen: {
      onMissing: 'fail',
      excludeSectors: ['Financial Services', 'Utilities'],
      rules: [
        { metric: 'pe', op: '>', value: 0 },
        { metric: 'marketCap', op: '>=', value: 5000 * CR },
      ],
    },
    scoring: {
      earningsYield: { weight: 50, bad: 0.02, good: 0.1 },
      roa: { weight: 50, bad: 0.03, good: 0.2 },
    },
  },

  lynch: {
    id: 'lynch',
    name: 'Growth at a reasonable price',
    investor: 'Peter Lynch',
    summary: 'Fast growers you can still buy cheaply: the P/E should not exceed the growth rate (PEG at most 1), with low debt.',
    picks: ['PEG (P/E ÷ earnings growth %) at most 1', 'Earnings growth between 15% and 50% (faster is rarely sustainable)', 'Debt/equity at most 0.6'],
    source: 'Peter Lynch, One Up on Wall Street (fast growers, the P/E-to-growth rule, avoid heavy debt).',
    limits: 'The free data gives last year\'s earnings growth, not a multi-year rate, so one unusual year can distort the PEG.',
    pairsWith: 'Minervini Trend Template',
    screen: {
      onMissing: 'fail',
      rules: [
        { metric: 'peg', op: '<=', value: 1 },
        { metric: 'earningsGrowth', op: '>=', value: 0.15 },
        { metric: 'earningsGrowth', op: '<=', value: 0.5 },
        { metric: 'debtToEquity', op: '<=', value: 0.6 },
      ],
    },
    scoring: {
      peg: { weight: 40, bad: 2, good: 0.5 },
      earningsGrowth: { weight: 25, bad: 0.1, good: 0.35 },
      roe: { weight: 20, bad: 0.08, good: 0.25 },
      debtToEquity: { weight: 15, bad: 0.8, good: 0 },
    },
  },

  jhunjhunwala: {
    id: 'jhunjhunwala',
    name: 'Growth and quality at a sensible price',
    investor: 'Rakesh Jhunjhunwala (inspired)',
    summary: 'Businesses with a big opportunity, strong growth and good returns, bought at a sensible valuation and held for years ("buy right, sit tight"). Debt is acceptable when the rest is strong.',
    picks: ['Return on equity at least 15%', 'Earnings growth at least 15% and sales growth at least 10%', 'P/E at most 45 and PEG at most 2', 'Debt/equity at most 1.5'],
    source: 'His interviews as reported by Outlook Business and others: size of opportunity, competitiveness and valuation; buy the business; never pay unreasonable prices; hold for the long term.',
    limits: 'He never published fixed numbers; these thresholds are an interpretation. Management quality and the size of the opportunity cannot be measured from free data.',
    pairsWith: 'Buy right, sit tight',
    screen: {
      onMissing: 'fail',
      rules: [
        { metric: 'roe', op: '>=', value: 0.15 },
        { metric: 'earningsGrowth', op: '>=', value: 0.15 },
        { metric: 'revenueGrowth', op: '>=', value: 0.1 },
        { metric: 'pe', op: '>', value: 0 },
        { metric: 'pe', op: '<=', value: 45 },
        { metric: 'peg', op: '<=', value: 2 },
        { metric: 'debtToEquity', op: '<=', value: 1.5 },
      ],
    },
    scoring: {
      earningsGrowth: { weight: 25, bad: 0.1, good: 0.35 },
      roe: { weight: 25, bad: 0.12, good: 0.3 },
      revenueGrowth: { weight: 15, bad: 0.05, good: 0.25 },
      peg: { weight: 20, bad: 2.5, good: 0.8 },
      operatingMargin: { weight: 15, bad: 0.08, good: 0.3 },
    },
  },

  qglp: {
    id: 'qglp',
    name: 'QGLP',
    investor: 'Raamdeo Agrawal (Motilal Oswal)',
    summary: 'Quality, Growth, Longevity and Price: high-quality businesses growing fast, with a long runway, at a price that is favourable for their growth.',
    picks: ['Quality: return on equity at least 20%', 'Growth: earnings and sales growth at least 15%', 'Longevity: operating margin at least 15% and market cap at least ₹20,000 cr (established leaders)', 'Price: PEG at most 1.5'],
    source: 'Raamdeo Agrawal\'s QGLP framework (Motilal Oswal wealth creation studies and interviews); growth screens of at least 15% are commonly cited for it.',
    limits: 'Longevity (how long the advantage lasts) cannot be measured from free data; margin and size are rough stand-ins. Last year\'s growth only.',
    pairsWith: 'Buy right, sit tight',
    screen: {
      onMissing: 'fail',
      rules: [
        { metric: 'roe', op: '>=', value: 0.2 },
        { metric: 'earningsGrowth', op: '>=', value: 0.15 },
        { metric: 'revenueGrowth', op: '>=', value: 0.15 },
        { metric: 'operatingMargin', op: '>=', value: 0.15 },
        { metric: 'marketCap', op: '>=', value: 20000 * CR },
        { metric: 'peg', op: '<=', value: 1.5 },
      ],
    },
    scoring: {
      roe: { weight: 25, bad: 0.15, good: 0.35 },
      earningsGrowth: { weight: 20, bad: 0.1, good: 0.3 },
      revenueGrowth: { weight: 15, bad: 0.1, good: 0.3 },
      operatingMargin: { weight: 15, bad: 0.1, good: 0.35 },
      peg: { weight: 25, bad: 2, good: 0.7 },
    },
  },

  oneil: {
    id: 'oneil',
    name: 'CAN SLIM fundamentals',
    investor: 'William O\'Neil',
    summary: 'The "C" and "A" of CAN SLIM: companies whose earnings and sales are growing fast right now, with high returns. Pair it with the CAN SLIM breakout strategy for the timing.',
    picks: ['Earnings growth at least 25%', 'Sales growth at least 20%', 'Return on equity at least 17%'],
    source: 'William O\'Neil, How to Make Money in Stocks (current and annual earnings growth of 25%+, ROE of 17%+).',
    limits: 'Uses last year\'s growth; O\'Neil also wanted 3 years of 25% annual growth and accelerating quarters, which needs data the free source does not give.',
    pairsWith: 'CAN SLIM breakout',
    screen: {
      onMissing: 'fail',
      rules: [
        { metric: 'earningsGrowth', op: '>=', value: 0.25 },
        { metric: 'revenueGrowth', op: '>=', value: 0.2 },
        { metric: 'roe', op: '>=', value: 0.17 },
      ],
    },
    scoring: {
      earningsGrowth: { weight: 40, bad: 0.2, good: 0.6 },
      revenueGrowth: { weight: 30, bad: 0.15, good: 0.4 },
      roe: { weight: 30, bad: 0.15, good: 0.35 },
    },
  },
};

export const profileById = (id: ProfileId): Profile => PROFILES[id];

/** Descriptions for the website. */
export const PROFILES_INFO: ProfileInfo[] = PROFILE_IDS.map((id) => {
  const { screen: _s, scoring: _c, ...info } = PROFILES[id];
  return info;
});

/** The study settings to use for a style: its own screen and scoring, or config/study.json for 'balanced'. */
export function studyConfigFor(cfg: StudyConfig, id: ProfileId): StudyConfig {
  const p = PROFILES[id];
  return { ...cfg, screen: p.screen ?? cfg.screen, scoring: p.scoring ?? cfg.scoring };
}
