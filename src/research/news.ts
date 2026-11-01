import { headlineSentiment } from '../study/sentiment';
import type { Announcement, NewsArticle } from './types';

const CATEGORIES: [string, RegExp][] = [
  ['Results', /\b(results?|q[1-4]|quarter(ly)?|profit|revenue|earnings|ebitda|net loss)\b/i],
  ['Management', /\b(ceo|cfo|md|managing director|chairman|director|board|appoint(s|ed|ment)?|resign(s|ed|ation)?|kmp)\b/i],
  ['Business', /\b(order|contract|wins?|bags|acquisition|acquire[sd]?|merger|expansion|capex|plant|launch(es|ed)?|partnership|jv|joint venture)\b/i],
  ['Regulatory / legal', /\b(sebi|usfda|fda|warning letter|observation|gst|tax|notice|penalty|court|litigation|probe|raid|ban)\b/i],
  ['Corporate action', /\b(dividend|bonus|split|buyback|rights issue|record date|agm|egm)\b/i],
];

export function categorize(text: string): string {
  return CATEGORIES.find(([, re]) => re.test(text))?.[0] ?? 'Other';
}

export interface ClassifiedNews {
  title: string;
  link: string;
  source?: string;
  date: string;
  category: string;
  /** Word-list sentiment of the headline, -1..1. An automated interpretation, not a fact. */
  sentiment: number;
}

export function classifyNews(items: NewsArticle[]): ClassifiedNews[] {
  return items.map((a) => ({
    title: a.title,
    link: a.link,
    source: a.source,
    date: a.publishedAt.toISOString().slice(0, 10),
    category: categorize(a.title),
    sentiment: Math.round(headlineSentiment(a.title) * 100) / 100,
  }));
}

export function classifyAnnouncements(items: Announcement[]) {
  return items.map((a) => ({ ...a, category: categorize(`${a.subject} ${a.detail ?? ''}`) }));
}
