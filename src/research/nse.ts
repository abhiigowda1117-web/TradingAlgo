import type { Announcement } from './types';

type Fetch = typeof fetch;

const NSE = 'https://www.nseindia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Official pages where a person can verify announcements, results and filings. Always shown. */
export function officialLinks(symbol: string): { label: string; url: string }[] {
  const s = encodeURIComponent(symbol);
  return [
    { label: 'NSE quote page (announcements, results, shareholding)', url: `${NSE}/get-quotes/equity?symbol=${s}` },
    { label: 'NSE corporate announcements', url: `${NSE}/companies-listing/corporate-filings-announcements?symbol=${s}` },
    { label: 'NSE financial results', url: `${NSE}/companies-listing/corporate-filings-financial-results?symbol=${s}` },
    { label: 'BSE corporate announcements (search by company)', url: 'https://www.bseindia.com/corporates/ann.html' },
  ];
}

/** NSE dates look like "01-Nov-2026 18:30:00"; returns YYYY-MM-DD or the raw text. */
export function nseDate(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s);
  if (!m) return s;
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2]!.toLowerCase()) + 1;
  return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : s;
}

/** Maps NSE's announcement JSON defensively; unknown shapes produce an error rather than guesses. */
export function parseNseAnnouncements(json: unknown, max = 25): Announcement[] {
  const rows = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : null;
  if (!rows) throw new Error('unexpected NSE response format');
  return rows
    .map((r) => r as Record<string, unknown>)
    .map((r) => ({
      date: nseDate(r.an_dt ?? r.sort_date ?? r.date),
      subject: String(r.desc ?? r.subject ?? '').trim(),
      detail: r.attchmntText ? String(r.attchmntText).trim() : undefined,
      link: typeof r.attchmntFile === 'string' && r.attchmntFile.startsWith('http') ? r.attchmntFile : undefined,
    }))
    .filter((a) => a.subject)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, max);
}

/**
 * Corporate announcements from NSE's website data endpoint. This is NOT an official API: NSE
 * requires browser cookies and may block automated requests at any time. Callers must treat
 * failure as normal and fall back to `officialLinks`.
 */
export async function fetchNseAnnouncements(symbol: string, fetchFn: Fetch = fetch, timeoutMs = 10_000): Promise<Announcement[]> {
  const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' };
  const home = await fetchFn(`${NSE}/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const cookies = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetchFn(`${NSE}/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`, {
    headers: { ...headers, Cookie: cookies, Referer: `${NSE}/get-quotes/equity?symbol=${encodeURIComponent(symbol)}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`NSE returned HTTP ${res.status}`);
  return parseNseAnnouncements(await res.json());
}
