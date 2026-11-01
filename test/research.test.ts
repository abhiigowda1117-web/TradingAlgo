import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assess } from '../src/research/assessment';
import { analyzeFundamentals, cagr, findMetric } from '../src/research/fundamentals';
import { researchMarkdown } from '../src/research/markdown';
import { categorize, classifyNews } from '../src/research/news';
import { fetchNseAnnouncements, nseDate, officialLinks, parseNseAnnouncements } from '../src/research/nse';
import { median, resolvePeers, type PeerConfig } from '../src/research/peers';
import { researchCompany, type ResearchReport } from '../src/research/research';
import { mapProfile, mapStatement, type ResearchSources } from '../src/research/sources';
import { analyzeTechnicals, classifyTrend, macd, supportResistance } from '../src/research/technicals';
import type { Candle, CompanyProfile, StatementPeriod } from '../src/research/types';
import { ema } from '../src/trading/indicators';
import { createDashboardServer } from '../src/web/server';
import { syntheticCandles } from './helpers';

// ---------------------------------------------------------------- fixtures

const NOW = new Date('2026-11-02T10:00:00Z');

const quoteSummary = {
  assetProfile: { longBusinessSummary: 'Makes widgets.', sector: 'Industrials', industry: 'Machinery', website: 'https://example.com', fullTimeEmployees: 1200, companyOfficers: [{ name: 'A. Person', title: 'MD' }] },
  price: { longName: 'Example Industries Limited', regularMarketPrice: 250, regularMarketTime: new Date('2026-11-02T09:55:00Z'), marketCap: 5e10, currency: 'INR', exchangeName: 'NSE' },
  financialData: { returnOnEquity: 0.2, debtToEquity: 40, currentRatio: 1.8, operatingMargins: 0.15, profitMargins: 0.1, totalRevenue: 1e10, operatingCashflow: 1.2e9, freeCashflow: 6e8, revenueGrowth: 0.12, earningsGrowth: 0.15 },
  defaultKeyStatistics: { trailingEps: 12.5, forwardEps: 14, priceToBook: { raw: 3.2 }, enterpriseToEbitda: 11 },
  summaryDetail: { trailingPE: 20, forwardPE: 17.8, dividendYield: 0.01, beta: 0.9 },
};

const annualRows = [2022, 2023, 2024, 2025].map((y, i) => ({
  date: new Date(`${y}-03-31T00:00:00Z`),
  totalRevenue: 7e9 * 1.12 ** i,
  operatingIncome: 0.14 * 7e9 * 1.12 ** i,
  netIncome: 0.09 * 7e9 * 1.12 ** i,
  dilutedEPS: 8 + i,
  EBIT: 1e9 + i * 1e8,
  totalAssets: 1e10,
  currentLiabilities: 2e9,
  totalDebt: 2e9,
  stockholdersEquity: 5e9,
  operatingCashFlow: 1e9,
  capitalExpenditure: -4e8,
}));

const profile = (overrides: Partial<CompanyProfile> = {}): CompanyProfile => ({ ...mapProfile('EXAMPLE', quoteSummary), ...overrides });
const annual: StatementPeriod[] = annualRows.map(mapStatement);

function fakeSources(o: Partial<Record<keyof ResearchSources, unknown>> = {}): ResearchSources & { calls: string[] } {
  const calls: string[] = [];
  const fail = (k: string) => o[k as keyof ResearchSources] instanceof Error;
  return {
    calls,
    async profile(symbol) {
      calls.push(`profile:${symbol}`);
      if (fail('profile')) throw o.profile;
      return symbol === 'EXAMPLE' ? profile() : mapProfile(symbol, { ...quoteSummary, price: { longName: `${symbol} Ltd`, regularMarketPrice: 100 }, summaryDetail: { trailingPE: 15 } });
    },
    async statements() {
      if (fail('statements')) throw o.statements;
      return { annual, quarterly: [] };
    },
    async candles() {
      if (fail('candles')) throw o.candles;
      return (o.candles as Candle[] | undefined) ?? syntheticCandles(400);
    },
    async news() {
      if (fail('news')) throw o.news;
      return [{ title: 'Example Industries Q2 profit jumps 20%, beats estimates', link: 'https://news.example/1', source: 'ET', publishedAt: new Date('2026-11-01T00:00:00Z') }];
    },
    async announcements() {
      if (fail('announcements')) throw o.announcements;
      return parseNseAnnouncements([{ an_dt: '01-Nov-2026 18:30:00', desc: 'Outcome of Board Meeting', attchmntText: 'Financial results for the quarter ended September 30, 2026', attchmntFile: 'https://nsearchives.nseindia.com/x.pdf' }]);
    },
  };
}

const peerCfg: PeerConfig = { groups: { Machines: ['EXAMPLE', 'PEERA', 'PEERB'] }, custom: { SOLO: ['X1'] } };

// ---------------------------------------------------------------- data mapping

describe('research data mapping', () => {
  it('maps the provider profile, converting debt/equity from percent', () => {
    const p = profile();
    expect(p).toMatchObject({ name: 'Example Industries Limited', sector: 'Industrials', price: 250, marketCap: 5e10, employees: 1200 });
    expect(p.priceTime).toBe('2026-11-02T09:55:00.000Z');
    expect(p.stats.priceToBook).toBe(3.2);
    const f = analyzeFundamentals(p, [], []);
    expect(findMetric(f.metrics, 'debtToEquity')).toBe(0.4);
  });

  it('maps statement rows and keeps missing fields as null', () => {
    const s = mapStatement({ date: new Date('2025-03-31T00:00:00Z'), totalRevenue: 100 });
    expect(s.periodEnd).toBe('2025-03-31');
    expect(s.revenue).toBe(100);
    expect(s.netIncome).toBeNull();
    expect(s.ebit).toBeNull();
  });
});

// ---------------------------------------------------------------- fundamentals

describe('fundamentals', () => {
  const f = analyzeFundamentals(profile(), annual, []);

  it('labels provider figures Reported, derived figures Calculated with a formula, forecasts Estimate', () => {
    const roe = f.metrics.find((m) => m.key === 'roe')!;
    expect(roe).toMatchObject({ kind: 'reported', value: 0.2, source: 'Yahoo Finance' });
    const roce = f.metrics.find((m) => m.key === 'roce')!;
    expect(roce.kind).toBe('calculated');
    expect(roce.formula).toMatch(/EBIT/);
    expect(roce.value).toBeCloseTo(1.3e9 / 8e9, 10); // latest EBIT / (assets - current liabilities)
    expect(f.metrics.find((m) => m.key === 'peForward')!.kind).toBe('estimate');
  });

  it('calculates growth and CAGR from the statements', () => {
    expect(findMetric(f.growth, 'revenueGrowthAnnual')).toBeCloseTo(0.12, 10);
    expect(findMetric(f.growth, 'revenueCagr')).toBeCloseTo(0.12, 2);
    expect(f.annual.at(-1)!.operatingMargin).toBeCloseTo(0.14, 10);
    expect(cagr(-5, 10, 3)).toBeNull(); // losses make CAGR meaningless
  });

  it('never invents numbers: missing inputs are Not Available', () => {
    const empty = analyzeFundamentals(profile({ stats: {}, marketCap: null, priceTime: null }), [], []);
    for (const m of [...empty.metrics, ...empty.growth]) {
      expect(m.value).toBeNull();
      expect(m.kind).toBe('unavailable');
    }
  });
});

// ---------------------------------------------------------------- technicals

describe('technicals', () => {
  it('computes MACD as EMA12 − EMA26 with an EMA9 signal', () => {
    const closes = syntheticCandles(300).map((c) => c.close);
    const m = macd(closes);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    expect(m.line[299]).toBeCloseTo(e12[299]! - e26[299]!, 10);
    expect(Number.isNaN(m.signal[30])).toBe(true); // signal needs 9 MACD values after warm-up
    expect(m.histogram[299]).toBeCloseTo(m.line[299]! - m.signal[299]!, 10);
  });

  it('finds support and resistance from repeated swing points', () => {
    // Zigzag between ~100 and ~120, ending at 110.
    const c: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const phase = i % 20;
      const mid = phase < 10 ? 100 + phase * 2 : 120 - (phase - 10) * 2;
      return { time: new Date(2026, 0, i + 1), open: mid, high: mid + 0.5, low: mid - 0.5, close: mid, volume: 1000 };
    });
    c.push({ time: new Date(2026, 4, 1), open: 110, high: 110.2, low: 109.8, close: 110, volume: 1000 });
    const sr = supportResistance(c);
    expect(sr.supports[0]!.price).toBeCloseTo(99.5, 0);
    expect(sr.resistances[0]!.price).toBeCloseTo(120.5, 0);
    expect(sr.supports[0]!.touches).toBeGreaterThan(2);
  });

  it('classifies trend from price and moving averages', () => {
    expect(classifyTrend(110, 105, 100, 99).trend).toBe('Uptrend');
    expect(classifyTrend(90, 95, 100, 101).trend).toBe('Downtrend');
    expect(classifyTrend(100, 105, 100, 99).trend).toBe('Sideways / mixed');
    expect(classifyTrend(100, 105, NaN, NaN).trend).toBe('Not Available');
  });

  it('reports Not Available instead of numbers when history is too short', () => {
    const t = analyzeTechnicals(syntheticCandles(60));
    expect(t.ema200).toBeNull();
    expect(t.trend.trend).toBe('Not Available');
    expect(t.ema20).not.toBeNull();
    expect(t.dataNote).toMatch(/not real-time/);
  });
});

// ---------------------------------------------------------------- news and announcements

describe('news and NSE announcements', () => {
  it('categorises headlines and scores their tone', () => {
    expect(categorize('Company Q2 results: profit up 12%')).toBe('Results');
    expect(categorize('CFO resigns with immediate effect')).toBe('Management');
    expect(categorize('Bags ₹500 crore order from railways')).toBe('Business');
    expect(categorize('Receives USFDA warning letter')).toBe('Regulatory / legal');
    const [n] = classifyNews([{ title: 'Shares plunge after fraud probe', link: 'l', publishedAt: NOW }]);
    expect(n!.sentiment).toBeLessThan(0);
  });

  it('parses the NSE announcement format and NSE dates', () => {
    expect(nseDate('01-Nov-2026 18:30:00')).toBe('2026-11-01');
    const a = parseNseAnnouncements([
      { an_dt: '15-Oct-2026 10:00:00', desc: 'Older', attchmntFile: 'javascript:alert(1)' },
      { an_dt: '01-Nov-2026 18:30:00', desc: 'Newer', attchmntFile: 'https://nsearchives.nseindia.com/a.pdf' },
      { an_dt: '01-Nov-2026', desc: '' },
    ]);
    expect(a.map((x) => x.subject)).toEqual(['Newer', 'Older']);
    expect(a[1]!.link).toBeUndefined(); // only http(s) links are kept
    expect(() => parseNseAnnouncements({ unexpected: true })).toThrow(/unexpected/);
  });

  it('fetches with the cookie handshake, and reports failure instead of guessing', async () => {
    const seen: string[] = [];
    const ok: typeof fetch = async (url, init) => {
      seen.push(`${url} cookie=${(init?.headers as Record<string, string>)?.Cookie ?? ''}`);
      return String(url).includes('/api/')
        ? new Response(JSON.stringify([{ an_dt: '01-Nov-2026 18:30:00', desc: 'Board meeting' }]), { status: 200 })
        : new Response('', { status: 200, headers: { 'Set-Cookie': 'nsit=abc; Path=/' } });
    };
    expect(await fetchNseAnnouncements('EXAMPLE', ok)).toHaveLength(1);
    expect(seen[1]).toMatch(/cookie=nsit=abc/);
    const blocked: typeof fetch = async (url) => new Response('denied', { status: String(url).includes('/api/') ? 401 : 200 });
    await expect(fetchNseAnnouncements('EXAMPLE', blocked)).rejects.toThrow(/401/);
    expect(officialLinks('M&M')[0]!.url).toContain('symbol=M%26M');
  });
});

// ---------------------------------------------------------------- peers and assessment

describe('peers and assessment', () => {
  it('resolves peers: explicit, then custom, then group, else none', () => {
    expect(resolvePeers('EXAMPLE', peerCfg, ['z1', 'EXAMPLE']).peers).toEqual(['Z1']);
    expect(resolvePeers('SOLO', peerCfg).peers).toEqual(['X1']);
    expect(resolvePeers('EXAMPLE', peerCfg).peers).toEqual(['PEERA', 'PEERB']);
    expect(resolvePeers('HIKAL', peerCfg)).toEqual({ peers: [], basis: 'none configured' });
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([null])).toBeNull();
  });

  const t = analyzeTechnicals(syntheticCandles(400));

  it('flags red flags from the numbers and says so when there are none', () => {
    const risky = analyzeFundamentals(profile({ stats: { debtToEquity: 250, profitMargins: -0.05, freeCashflow: -1e8 } }), [], []);
    const a = assess(risky, t, [], [], 'Industrials');
    const text = a.risks.map((r) => r.text).join(' ');
    expect(text).toMatch(/loss-making/);
    expect(text).toMatch(/High leverage/);
    expect(text).toMatch(/Free cash flow is negative/);
  });

  it('does not treat bank leverage as a red flag, and says when peers are missing', () => {
    const bank = analyzeFundamentals(profile({ stats: { debtToEquity: 600, trailingPE: 12 } }), [], []);
    const a = assess(bank, t, [], [], 'Financial Services');
    expect(a.risks.map((r) => r.text).join(' ')).not.toMatch(/High leverage/);
    expect(a.financialStrength[0]!.text).toMatch(/financial company/);
    expect(a.valuation[0]!.text).toMatch(/No peer group/);
  });

  it('never states price targets or predictions', () => {
    const a = assess(analyzeFundamentals(profile(), annual, []), t, [], [], 'Industrials');
    const all = Object.values(a).flat().map((i) => i.text).join(' ');
    expect(all).not.toMatch(/target|will (rise|fall|reach)|guarantee/i);
    expect(a.bullish.length).toBeGreaterThan(0);
    expect(a.bearish.length).toBeGreaterThan(0);
  });

  it('says Insufficient data when there is nothing to assess', () => {
    const empty = analyzeFundamentals(profile({ stats: {} }), [], []);
    const a = assess(empty, analyzeTechnicals([]), null, [], null);
    expect(a.growth[0]!.text).toMatch(/Insufficient data/);
    expect(a.businessQuality[0]!.text).toMatch(/Insufficient data/);
  });
});

// ---------------------------------------------------------------- full report

describe('researchCompany', () => {
  it('builds every section with sources and dates', async () => {
    const r = await researchCompany('example', fakeSources(), { now: NOW, peerConfig: peerCfg });
    expect(r.symbol).toBe('EXAMPLE');
    expect(r.overview.name).toBe('Example Industries Limited');
    expect(r.technicals?.ema200).not.toBeNull();
    expect(r.announcements).toMatchObject({ status: 'ok' });
    expect(r.announcements.items[0]).toMatchObject({ date: '2026-11-01', category: 'Results' });
    expect(r.news?.positives).toHaveLength(1);
    expect(r.peers.rows.map((p) => p.symbol)).toEqual(['EXAMPLE', 'PEERA', 'PEERB']);
    expect(r.peers.medians?.pe).toBe(15);
    expect(r.sources.length).toBeGreaterThanOrEqual(4);
    expect(r.sources.every((s) => s.retrievedAt === NOW.toISOString())).toBe(true);
    expect(r.overview.priceNote).toMatch(/not real-time/i);
    expect(r.warnings).toEqual([]);
  });

  it('keeps going when sources fail, with warnings and Not Available sections', async () => {
    const r = await researchCompany('EXAMPLE', fakeSources({ statements: new Error('timeout'), news: new Error('down'), announcements: new Error('NSE returned HTTP 401'), candles: new Error('429') }), { now: NOW, peerConfig: peerCfg });
    expect(r.warnings.join(' ')).toMatch(/statements unavailable/);
    expect(r.warnings.join(' ')).toMatch(/NSE announcements could not be fetched/);
    expect(r.technicals).toBeNull();
    expect(r.news).toBeNull();
    expect(r.announcements.status).toBe('unavailable');
    expect(r.announcements.links.length).toBeGreaterThan(0);
    const md = researchMarkdown(r);
    expect(md).toContain('Not Available');
    expect(md).not.toMatch(/NaN|undefined|null/);
  });

  it('rejects invalid symbols and symbols with no data', async () => {
    await expect(researchCompany('../etc', fakeSources())).rejects.toThrow(/not a valid NSE symbol/);
    const nothing = { ...fakeSources(), profile: async () => ({ ...profile(), name: null, price: null }) };
    await expect(researchCompany('NOPE', nothing, { peerConfig: peerCfg })).rejects.toThrow(/No data found/);
  });

  it('renders a Markdown report with labels, all six sections and source links', async () => {
    const md = researchMarkdown(await researchCompany('EXAMPLE', fakeSources(), { now: NOW, peerConfig: peerCfg }));
    for (const h of ['## 1. Company overview', '## 2. Fundamentals', '## 3. Technical analysis', '## 4. News and corporate developments', '## 5. Competitor comparison', '## 6. Research summary', '## Sources']) expect(md).toContain(h);
    expect(md).toContain('| Return on capital employed (ROCE) |');
    expect(md).toMatch(/\| Calculated \|/);
    expect(md).toMatch(/\| Estimate \|/);
    expect(md).toContain('https://www.nseindia.com/get-quotes/equity?symbol=EXAMPLE');
    expect(md).not.toMatch(/NaN|undefined/);
  });
});

// ---------------------------------------------------------------- separation from trading

describe('separation from trade execution', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

  it('research and dashboard code never imports brokers, the engine, or the trading factory', () => {
    const scope = [...files('src/research'), ...files('src/web'), 'src/cli/research.ts', 'src/cli/dashboard.ts'];
    for (const f of scope) {
      const src = readFileSync(f, 'utf8');
      // Any import form: `import x from '...'`, `import '...'`, `import('...')`, `require('...')`.
      expect(src, f).not.toMatch(/(?:from|import|require)\s*\(?\s*['"][^'"]*(brokers|trading\/engine|factory|kiteClient|paperBroker)[^'"]*['"]/);
    }
  });
});

// ---------------------------------------------------------------- dashboard server

describe('dashboard server', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(research: (s: string, p: string[]) => Promise<ResearchReport>) {
    const server = createDashboardServer({ html: '<html>dashboard</html>', research });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    close = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('serves the page and research JSON, validates input, caches results and reports errors', async () => {
    let calls = 0;
    const report = await researchCompany('EXAMPLE', fakeSources(), { now: NOW, peerConfig: peerCfg });
    const base = await start(async (s) => {
      calls++;
      if (s === 'BROKEN') throw new Error('Yahoo is rate-limiting requests');
      return report;
    });
    expect(await (await fetch(`${base}/`)).text()).toContain('dashboard');
    expect((await fetch(`${base}/vendor/chart.umd.js`)).status).toBe(404); // only registered assets are served
    expect((await fetch(`${base}/api/research?symbol=<script>`)).status).toBe(400);
    expect((await fetch(`${base}/api/research?symbol=EXAMPLE&peers=A,B,C,D,E,F,G`)).status).toBe(400);
    const ok = await fetch(`${base}/api/research?symbol=example`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).symbol).toBe('EXAMPLE');
    const again = await (await fetch(`${base}/api/research?symbol=EXAMPLE`)).json();
    expect(again.cached).toBe(true);
    expect(calls).toBe(1);
    await fetch(`${base}/api/research?symbol=EXAMPLE&refresh=1`);
    expect(calls).toBe(2);
    const bad = await fetch(`${base}/api/research?symbol=BROKEN`);
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toMatch(/rate-limiting/);
    expect((await fetch(`${base}/api/research?symbol=X`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
