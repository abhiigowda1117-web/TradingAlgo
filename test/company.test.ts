import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { companyUpdate, formatUpdate, mapQuote, resolveCompany, type QuoteSnapshot, type UpdateSources } from '../src/research/companyUpdate';
import { syntheticCandles } from './helpers';

const NOW = new Date('2026-11-02T10:30:00Z');

const quote = (ticker: string, extra: Partial<QuoteSnapshot> = {}): QuoteSnapshot => ({
  ...mapQuote({
    symbol: ticker,
    longName: 'Reliance Industries Limited',
    regularMarketPrice: 1246.45,
    regularMarketChange: 82.85,
    regularMarketChangePercent: 7.12,
    regularMarketPreviousClose: 1163.6,
    regularMarketOpen: 1180,
    regularMarketDayHigh: 1250,
    regularMarketDayLow: 1175,
    regularMarketVolume: 24_000_000,
    averageDailyVolume3Month: 10_000_000,
    fiftyTwoWeekHigh: 1600,
    fiftyTwoWeekLow: 1100,
    marketCap: 1.677e13,
    trailingPE: 24.3,
    regularMarketTime: new Date('2026-11-02T10:00:00Z'),
    marketState: 'REGULAR',
  }),
  ...extra,
});

function fake(o: { quotes?: Record<string, QuoteSnapshot | null>; hits?: { symbol: string; name: string; exchange: string }[]; newsFails?: boolean; nseFails?: boolean } = {}): UpdateSources & { searched: string[] } {
  const searched: string[] = [];
  return {
    searched,
    quote: async (t) => (o.quotes ? (o.quotes[t] ?? null) : quote(t)),
    search: async (q) => {
      searched.push(q);
      return o.hits ?? [];
    },
    candles: async () => syntheticCandles(300),
    news: async () => {
      if (o.newsFails) throw new Error('Google News 503');
      return [{ title: 'Reliance shares jump 7% after Q2 profit beats estimates', link: 'https://n/1', source: 'Business Standard', publishedAt: new Date('2026-11-02T05:00:00Z') }];
    },
    announcements: async () => {
      if (o.nseFails) throw new Error('NSE returned HTTP 401');
      return [{ date: '2026-10-31', subject: 'Outcome of Board Meeting', detail: 'Financial results for the quarter ended September 30, 2026' }];
    },
  };
}

describe('resolving what the user typed', () => {
  it('uses an NSE symbol directly, without searching', async () => {
    const src = fake();
    const r = await resolveCompany('reliance', src);
    expect(r).toMatchObject({ ticker: 'RELIANCE.NS', symbol: 'RELIANCE', matchedBy: 'NSE symbol' });
    expect(src.searched).toEqual([]);
  });

  it('searches by company name and prefers the NSE listing over BSE', async () => {
    const src = fake({
      quotes: { 'BEL.NS': quote('BEL.NS', { name: 'Bharat Electronics Limited' }) },
      hits: [
        { symbol: 'BEL.BO', name: 'Bharat Electronics', exchange: 'BSE' },
        { symbol: 'BELX', name: 'Some US stock', exchange: 'NYQ' },
        { symbol: 'BEL.NS', name: 'Bharat Electronics', exchange: 'NSI' },
      ],
    });
    const r = await resolveCompany('Bharat Electronics', src);
    expect(r.ticker).toBe('BEL.NS');
    expect(r.symbol).toBe('BEL');
    expect(src.searched).toEqual(['Bharat Electronics']);
  });

  it('falls back to search when a symbol-looking word is not an NSE symbol', async () => {
    const src = fake({ quotes: { 'TATA.NS': null, 'TATAMOTORS.NS': quote('TATAMOTORS.NS') }, hits: [{ symbol: 'TATAMOTORS.NS', name: 'Tata Motors', exchange: 'NSI' }] });
    expect((await resolveCompany('TATA', src)).ticker).toBe('TATAMOTORS.NS');
  });

  it('says clearly when nothing Indian matches', async () => {
    const src = fake({ quotes: {}, hits: [{ symbol: 'AAPL', name: 'Apple', exchange: 'NMS' }] });
    await expect(resolveCompany('Apple', src)).rejects.toThrow(/No NSE\/BSE listed company found/);
    await expect(resolveCompany('   ', src)).rejects.toThrow(/Type a company name/);
  });
});

describe('company update', () => {
  it('prints price, trend, news and announcements with dates and a delayed-data label', async () => {
    const text = formatUpdate(await companyUpdate('Reliance', fake(), { now: NOW }));
    expect(text).toContain('RELIANCE  ·  Reliance Industries Limited  (NSE)');
    expect(text).toContain('₹1,246.45');
    expect(text).toContain('+7.12%');
    expect(text).toMatch(/delayed, not real-time/);
    expect(text).toContain('2.4× the 3-month average');
    expect(text).toContain('TREND (daily, calculated)');
    expect(text).toMatch(/2026-11-02 {2}\[Results, positive\] {2}Reliance shares jump 7%/);
    expect(text).toContain('Outcome of Board Meeting');
    expect(text).toContain('not investment advice');
    expect(text).not.toMatch(/NaN|undefined|null/);
  });

  it('tags slowing-growth headlines as negative, not positive', async () => {
    const { classifyNews } = await import('../src/research/news');
    const [x] = classifyNews([{ title: 'RIL retail growth slows as festive sales shift', link: 'y', publishedAt: NOW }]);
    expect(x!.sentiment).toBeLessThanOrEqual(0);
  });

  it('shows Not Available instead of numbers when data is missing, and survives failing sources', async () => {
    const bare = quote('RELIANCE.NS', { open: null, volume: null, avgVolume3m: null, marketCap: null, pe: null, high52: null, low52: null });
    const u = await companyUpdate('RELIANCE', fake({ quotes: { 'RELIANCE.NS': bare }, newsFails: true, nseFails: true }), { now: NOW });
    const text = formatUpdate(u);
    expect(text).toMatch(/Open \/ Prev {2}Not Available/);
    expect(text).toMatch(/Market cap {3}Not Available/);
    expect(text).toMatch(/NEWS[^\n]*\n {2}Not Available/);
    expect(text).toMatch(/NSE ANNOUNCEMENTS[^\n]*\n {2}Not Available \(NSE returned HTTP 401\)/);
    expect(text).toContain('Note: News unavailable: Google News 503');
    expect(text).not.toMatch(/NaN|undefined|null/);
  });

  it('stays separate from trading code', () => {
    for (const f of ['src/research/companyUpdate.ts', 'src/cli/company.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/(?:from|import|require)\s*\(?\s*['"][^'"]*(brokers|trading\/engine|factory)[^'"]*['"]/);
    }
  });
});
