/** Shape of a company research report from /api/research (mirrors src/research/research.ts). */
export type Provenance = 'reported' | 'calculated' | 'estimate' | 'unavailable';
export type Unit = 'INR' | 'pct' | 'ratio' | 'x' | 'INR/share' | 'count';

export interface Metric { key: string; label: string; value: number | null; unit: Unit; kind: Provenance; source?: string; asOf?: string; formula?: string; note?: string }
export interface Period {
  periodEnd: string;
  revenue: number | null; operatingIncome: number | null; netIncome: number | null; eps: number | null;
  operatingCashFlow: number | null; freeCashFlow: number | null; totalDebt: number | null; equity: number | null;
  operatingMargin: number | null; netMargin: number | null;
}
export interface Interp { text: string; basis: string[] }
export interface Level { price: number; touches: number }
export interface PeerRow { symbol: string; name: string | null; marketCap: number | null; revenueGrowth: number | null; operatingMargin: number | null; netMargin: number | null; roe: number | null; debtToEquity: number | null; pe: number | null; pb: number | null; error?: string }

export interface ResearchReport {
  symbol: string;
  generatedAt: string;
  disclaimer: string;
  cached?: boolean;
  overview: { name: string | null; description: string | null; sector: string | null; industry: string | null; website: string | null; employees: number | null; officers: { name: string; title: string }[]; productsAndSegments: string; price: number | null; priceTime: string | null; priceNote: string };
  fundamentals: { metrics: Metric[]; growth: Metric[]; annual: Period[]; quarterly: Period[]; latestAnnual: string | null; latestQuarter: string | null };
  technicals: {
    lastClose: number | null; lastDate: string | null; dataNote: string;
    ema20: number | null; ema50: number | null; ema200: number | null; rsi14: number | null;
    macd: { line: number | null; signal: number | null; histogram: number | null; state: string };
    volume: { avg20: number | null; avg50: number | null; ratio: number | null; trend: string };
    high52: number | null; low52: number | null;
    returns: { label: string; value: number | null }[];
    trend: { trend: string; reason: string };
    supports: Level[]; resistances: Level[];
    series: { date: string; close: number; volume: number; ema20: number | null; ema50: number | null; ema200: number | null; macd: number | null; signal: number | null }[];
  } | null;
  news: { items: { title: string; link: string; source?: string; date: string; category: string; sentiment: number }[]; note: string } | null;
  announcements: { status: 'ok' | 'unavailable'; items: { date: string; subject: string; detail?: string; link?: string; category: string }[]; error?: string; links: { label: string; url: string }[] };
  peers: { basis: string; rows: PeerRow[]; medians: Omit<PeerRow, 'symbol' | 'name' | 'error'> | null; note: string };
  assessment: Record<'businessQuality' | 'financialStrength' | 'growth' | 'risks' | 'valuation' | 'technical' | 'bullish' | 'bearish', Interp[]>;
  buffett?: BuffettAnalysis;
  sources: { name: string; url?: string; retrievedAt: string; asOf?: string; note?: string }[];
  warnings: string[];
}

export type BuffettVerdict = 'meets' | 'close' | 'fails' | 'na' | 'judgement' | 'notApplicable';
export interface BuffettCheck {
  key: string;
  group: 'Business' | 'Financial' | 'Management' | 'Value';
  question: string;
  buffettWants: string;
  reality: string;
  verdict: BuffettVerdict;
  figures: { label: string; value: number | null; unit: Unit }[];
}
export interface BuffettAnalysis {
  periods: string[];
  financialSector: boolean;
  checks: BuffettCheck[];
  score: { met: number; close: number; failed: number; measurable: number; judgement: number };
  verdict: 'strong' | 'mixed' | 'weak' | 'insufficient';
  summary: string;
  strengths: string[];
  weaknesses: string[];
  valuation: {
    ownerEarnings: number | null; basis: string; marketCap: number | null; price: number | null;
    ownerEarningsYield: number | null; earningsYield: number | null;
    defaults: { growth: number; growthBasis: string; discountRate: number; terminalGrowth: number; years: number; marginOfSafety: number };
    estimatedValue: number | null; discountToValue: number | null;
  };
  notes: string[];
}

export interface SavedResearch { id: number; symbol: string; name: string | null; generatedAt: string }
