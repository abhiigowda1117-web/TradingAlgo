import { XMLParser } from 'fast-xml-parser';
import type { NewsArticle } from '../types';
import type { NewsProvider } from './types';

/** Parses a Google News RSS feed. Titles arrive as "Headline - Source"; the source suffix is split off. */
export function parseGoogleNewsRss(xml: string): NewsArticle[] {
  const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const raw = doc?.rss?.channel?.item ?? [];
  const items: Record<string, unknown>[] = Array.isArray(raw) ? raw : [raw];
  return items.flatMap((it) => {
    const full = String(it.title ?? '').trim();
    const sourceNode = it.source as { '#text'?: string } | string | undefined;
    const source = typeof sourceNode === 'string' ? sourceNode : sourceNode?.['#text'];
    const suffix = source ? ` - ${source}` : undefined;
    const title = suffix && full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
    const publishedAt = new Date(String(it.pubDate ?? ''));
    if (!title || Number.isNaN(publishedAt.getTime())) return [];
    return [{ title, link: String(it.link ?? ''), source, publishedAt }];
  });
}

export class GoogleNews implements NewsProvider {
  async getNews(query: string, since: Date, max: number): Promise<NewsArticle[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 trading-algo' } });
    if (!res.ok) throw new Error(`Google News ${res.status} for "${query}"`);
    return parseGoogleNewsRss(await res.text())
      .filter((a) => a.publishedAt >= since)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, max);
  }
}
