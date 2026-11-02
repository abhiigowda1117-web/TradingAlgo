import { newsQueryName } from '../study/study';
import { assess, type Assessment } from './assessment';
import { analyzeFundamentals, type FundamentalsSection } from './fundamentals';
import { classifyAnnouncements, classifyNews, type ClassifiedNews } from './news';
import { officialLinks } from './nse';
import { loadPeerConfig, median, peerRow, resolvePeers, type PeerConfig, type PeerRow } from './peers';
import type { ResearchSources } from './sources';
import { analyzeTechnicals, type TechnicalSection } from './technicals';
import type { Announcement, CompanyProfile, SourceRef, StatementPeriod } from './types';

export const DISCLAIMER =
  'Automated research for information only, not investment advice. Figures come from third-party data providers and may be delayed, revised or incomplete; verify against the company’s official filings on NSE/BSE before acting. Interpretations are rule-based and make no price predictions.';

export interface ResearchReport {
  symbol: string;
  generatedAt: string;
  disclaimer: string;
  overview: {
    name: string | null;
    description: string | null;
    sector: string | null;
    industry: string | null;
    website: string | null;
    employees: number | null;
    officers: { name: string; title: string }[];
    exchange: string | null;
    productsAndSegments: string;
    price: number | null;
    priceTime: string | null;
    priceNote: string;
  };
  fundamentals: FundamentalsSection;
  technicals: TechnicalSection | null;
  news: { items: ClassifiedNews[]; positives: ClassifiedNews[]; negatives: ClassifiedNews[]; note: string } | null;
  announcements: { status: 'ok' | 'unavailable'; items: (Announcement & { category: string })[]; error?: string; links: { label: string; url: string }[] };
  peers: { basis: string; rows: PeerRow[]; medians: Omit<PeerRow, 'symbol' | 'name' | 'error'> | null; note: string };
  assessment: Assessment;
  sources: SourceRef[];
  warnings: string[];
}

export interface ResearchOptions {
  peers?: string[];
  peerConfig?: PeerConfig;
  now?: Date;
  newsDays?: number;
}

const SYMBOL = /^[A-Z0-9&-]{1,20}$/;
export const isValidSymbol = (s: string) => SYMBOL.test(s);

export async function researchCompany(rawSymbol: string, src: ResearchSources, o: ResearchOptions = {}): Promise<ResearchReport> {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!isValidSymbol(symbol)) throw new Error(`"${rawSymbol}" is not a valid NSE symbol (letters, digits, & and - only)`);
  const now = o.now ?? new Date();
  const at = now.toISOString();
  const warnings: string[] = [];
  const sources: SourceRef[] = [];

  let profile: CompanyProfile;
  try {
    profile = await src.profile(symbol);
  } catch (e) {
    throw new Error(`Could not load ${symbol} from Yahoo Finance (${(e as Error).message}). Check the NSE symbol.`);
  }
  if (!profile.name && profile.price === null) throw new Error(`No data found for NSE symbol ${symbol}. Check the ticker.`);
  sources.push({ name: 'Yahoo Finance: profile, key statistics, price', url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}.NS`, retrievedAt: at, asOf: profile.priceTime?.slice(0, 10), note: 'Third-party data; price may be delayed' });

  let annual: StatementPeriod[] = [];
  let quarterly: StatementPeriod[] = [];
  try {
    ({ annual, quarterly } = await src.statements(symbol));
    sources.push({ name: 'Yahoo Finance: financial statements (annual, quarterly)', url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}.NS/financials`, retrievedAt: at, asOf: annual.at(-1)?.periodEnd, note: `${annual.length} annual and ${quarterly.length} quarterly periods` });
    if (!annual.length) warnings.push('No annual financial statements available from the data provider.');
  } catch (e) {
    warnings.push(`Financial statements unavailable: ${(e as Error).message}`);
  }
  const fundamentals = analyzeFundamentals(profile, annual, quarterly);

  let technicals: TechnicalSection | null = null;
  try {
    const candles = await src.candles(symbol, new Date(now.getTime() - 2 * 365.25 * 86_400_000));
    if (candles.length) {
      technicals = analyzeTechnicals(candles);
      sources.push({ name: 'Yahoo Finance: daily price history', retrievedAt: at, asOf: technicals.lastDate ?? undefined, note: 'End-of-day / delayed, not real-time' });
      if (candles.length < 220) warnings.push(`Only ${candles.length} trading days of history; EMA 200 and some indicators may be Not Available.`);
    } else warnings.push('No price history available.');
  } catch (e) {
    warnings.push(`Price history unavailable: ${(e as Error).message}`);
  }

  let news: ResearchReport['news'] = null;
  try {
    const days = o.newsDays ?? 30;
    const items = classifyNews(await src.news(`"${newsQueryName(profile.name ?? symbol)}" share`, new Date(now.getTime() - days * 86_400_000), 30));
    news = {
      items,
      positives: items.filter((n) => n.sentiment > 0.2),
      negatives: items.filter((n) => n.sentiment < -0.2),
      note: `Headlines from Google News (last ${days} days), aggregated from news publishers; not official disclosures. Positive/negative tags are automated headline scoring.`,
    };
    sources.push({ name: 'Google News RSS', url: `https://news.google.com/search?q=${encodeURIComponent(profile.name ?? symbol)}`, retrievedAt: at, asOf: items[0]?.date });
  } catch (e) {
    warnings.push(`News unavailable: ${(e as Error).message}`);
  }

  const links = officialLinks(symbol);
  let announcements: ResearchReport['announcements'];
  try {
    const items = classifyAnnouncements(await src.announcements(symbol));
    announcements = { status: 'ok', items, links };
    sources.push({ name: 'NSE corporate announcements (website data, unofficial endpoint)', url: links[1]!.url, retrievedAt: at, asOf: items[0]?.date });
  } catch (e) {
    announcements = { status: 'unavailable', items: [], error: (e as Error).message, links };
    warnings.push(`NSE announcements could not be fetched automatically (${(e as Error).message}); use the official links.`);
  }

  const { peers: peerSymbols, basis } = resolvePeers(symbol, o.peerConfig ?? loadPeerConfig(), o.peers);
  const rows: PeerRow[] = [peerRow(profile)];
  for (const p of peerSymbols) {
    try {
      rows.push(peerRow(await src.profile(p)));
    } catch (e) {
      rows.push({ symbol: p, name: null, marketCap: null, revenueGrowth: null, operatingMargin: null, netMargin: null, roe: null, debtToEquity: null, pe: null, pb: null, error: (e as Error).message });
    }
  }
  const others = rows.slice(1).filter((r) => !r.error);
  const medians = others.length
    ? {
        marketCap: median(others.map((r) => r.marketCap)),
        revenueGrowth: median(others.map((r) => r.revenueGrowth)),
        operatingMargin: median(others.map((r) => r.operatingMargin)),
        netMargin: median(others.map((r) => r.netMargin)),
        roe: median(others.map((r) => r.roe)),
        debtToEquity: median(others.map((r) => r.debtToEquity)),
        pe: median(others.map((r) => r.pe)),
        pb: median(others.map((r) => r.pb)),
      }
    : null;
  const peers = {
    basis,
    rows,
    medians,
    note: peerSymbols.length
      ? 'Peer figures from Yahoo Finance key statistics (trailing). Peers are chosen by configuration, not by an official classification.'
      : `No peers configured for ${symbol}. Add them in config/peers.json ("custom": {"${symbol}": ["PEER1","PEER2"]}) or enter them in the dashboard.`,
  };

  return {
    symbol,
    generatedAt: at,
    disclaimer: DISCLAIMER,
    overview: {
      name: profile.name,
      description: profile.description,
      sector: profile.sector,
      industry: profile.industry,
      website: profile.website,
      employees: profile.employees,
      officers: profile.officers,
      exchange: profile.exchange,
      productsAndSegments: 'Not Available: no structured free source. See the business description above and the segment note in the latest annual report (NSE quote page → Annual Reports).',
      price: profile.price,
      priceTime: profile.priceTime,
      priceNote: 'Last price from Yahoo Finance; may be delayed by 15 minutes or more. Not real-time.',
    },
    fundamentals,
    technicals,
    news,
    announcements,
    peers,
    assessment: assess(fundamentals, technicals ?? emptyTechnicals(), news?.items ?? null, rows.slice(1).filter((r) => !r.error), profile.sector),
    sources,
    warnings,
  };
}

function emptyTechnicals(): TechnicalSection {
  return {
    lastClose: null,
    lastDate: null,
    dataNote: 'Not Available',
    ema20: null,
    ema50: null,
    ema200: null,
    rsi14: null,
    macd: { line: null, signal: null, histogram: null, state: 'Not Available' },
    atr14: null,
    volume: { avg20: null, avg50: null, ratio: null, trend: 'Not Available' },
    high52: null,
    low52: null,
    returns: [],
    trend: { trend: 'Not Available', reason: 'No price history' },
    supports: [],
    resistances: [],
    series: [],
  };
}
