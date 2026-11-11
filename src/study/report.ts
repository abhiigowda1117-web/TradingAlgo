import type { MetricKey } from '../types';
import type { CompanyStudy } from './study';
import type { Watchlist } from './watchlist';

const PCT: MetricKey[] = ['roe', 'roa', 'revenueGrowth', 'earningsGrowth', 'profitMargin', 'operatingMargin', 'dividendYield', 'earningsYield'];
const LABEL: Record<MetricKey, string> = {
  price: 'Price',
  marketCap: 'Market cap',
  pe: 'P/E',
  pb: 'P/B',
  roe: 'Return on equity',
  roa: 'Return on assets',
  debtToEquity: 'Debt / equity',
  revenueGrowth: 'Revenue growth (YoY)',
  earningsGrowth: 'Earnings growth (YoY)',
  profitMargin: 'Net profit margin',
  operatingMargin: 'Operating margin',
  currentRatio: 'Current ratio',
  dividendYield: 'Dividend yield',
  freeCashflow: 'Free cash flow',
  earningsYield: 'Earnings yield (1 / P/E)',
  peg: 'PEG (P/E ÷ earnings growth %)',
  peTimesPb: 'P/E × P/B (Graham)',
};

export const crore = (x: number) => `₹${(x / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`;

export function fmtMetric(metric: MetricKey, v: number | undefined): string {
  if (v === undefined) return 'n/a';
  if (PCT.includes(metric)) return `${(v * 100).toFixed(1)}%`;
  if (metric === 'marketCap' || metric === 'freeCashflow') return crore(v);
  if (metric === 'price') return `₹${v.toFixed(2)}`;
  return v.toFixed(2);
}

const opText = { '>': '>', '>=': '≥', '<': '<', '<=': '≤' } as const;

function verdict(s: CompanyStudy, w: Watchlist | undefined): string {
  if (!w) return '';
  if (w.entries.some((e) => e.symbol === s.symbol)) return '**On the watchlist**: the trading engine may buy this stock when its entry signal fires.';
  const r = w.rejected.find((x) => x.symbol === s.symbol);
  return `**Not on the watchlist**${r ? `: ${r.reason}` : ''}.`;
}

/** One-company research note in Markdown. */
export function companyReport(s: CompanyStudy, watchlist?: Watchlist, now: Date = new Date()): string {
  const f = s.fundamentals;
  const strengths = s.fundamental.breakdown.filter((m) => (m.score ?? 0) >= 75);
  const weak = s.fundamental.breakdown.filter((m) => m.score !== undefined && m.score <= 25);
  const failed = s.screen.results.filter((r) => !r.passed);
  const sorted = [...s.sentiment.scored].sort((a, b) => b.score - a.score);
  const best = sorted.filter((x) => x.score > 0.2).slice(0, 3);
  const worst = sorted.filter((x) => x.score < -0.2).reverse().slice(0, 3);

  const L: string[] = [];
  L.push(`# ${f.name} (${s.symbol})`, '');
  L.push(`_Generated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC. This is an automated screen, not investment advice._`, '');
  L.push(`${[f.sector, f.industry].filter(Boolean).join(' · ') || 'Sector n/a'} · Price ${fmtMetric('price', f.price)} · Market cap ${fmtMetric('marketCap', f.marketCap)}`, '');
  L.push(verdict(s, watchlist), '');

  L.push('## Scores', '');
  L.push('| | Score |', '|---|---:|');
  L.push(`| **Combined** | **${s.combinedScore.toFixed(1)}** / 100 |`);
  L.push(`| Fundamentals | ${s.fundamental.score.toFixed(1)} / 100 (${(s.fundamental.coverage * 100).toFixed(0)}% data coverage) |`);
  L.push(`| News sentiment | ${s.sentiment.score >= 0 ? '+' : ''}${s.sentiment.score.toFixed(2)} (${s.sentiment.articles} articles) |`, '');

  L.push('## Fundamentals', '');
  L.push('| Metric | Value | Score | Weight |', '|---|---:|---:|---:|');
  for (const m of s.fundamental.breakdown) L.push(`| ${LABEL[m.metric]} | ${fmtMetric(m.metric, m.value)} | ${m.score ?? '–'} | ${m.weight} |`);
  L.push('');

  L.push('## Screen', '');
  for (const r of s.screen.results) {
    L.push(`- ${r.passed ? '✅' : '❌'} ${LABEL[r.rule.metric]} ${opText[r.rule.op]} ${fmtMetric(r.rule.metric, r.rule.value)} (actual ${fmtMetric(r.rule.metric, r.value)})`);
  }
  L.push('');

  L.push('## Strengths', '');
  L.push(...(strengths.length ? strengths.map((m) => `- ${LABEL[m.metric]}: ${fmtMetric(m.metric, m.value)}`) : ['- None stand out.']), '');

  L.push('## Red flags', '');
  const flags = [
    ...failed.map((r) => `- Fails screen: ${LABEL[r.rule.metric]} ${fmtMetric(r.rule.metric, r.value)}`),
    ...weak.map((m) => `- Weak ${LABEL[m.metric].toLowerCase()}: ${fmtMetric(m.metric, m.value)}`),
    ...(f.pe !== undefined && f.pe <= 0 ? ['- Loss-making (negative P/E)'] : []),
    ...worst.map((x) => `- Negative news: "${x.article.title}"`),
    ...s.warnings.map((w) => `- Data: ${w}`),
  ];
  L.push(...(flags.length ? flags : ['- None found.']), '');

  L.push('## News', '');
  if (s.sentiment.articles === 0) L.push('No recent articles found.', '');
  else {
    if (best.length) L.push('Most positive:', ...best.map((x) => `- [${x.article.title}](${x.article.link}) (${x.article.source ?? 'n/a'}, ${x.article.publishedAt.toISOString().slice(0, 10)}, ${x.score.toFixed(2)})`), '');
    if (worst.length) L.push('Most negative:', ...worst.map((x) => `- [${x.article.title}](${x.article.link}) (${x.article.source ?? 'n/a'}, ${x.article.publishedAt.toISOString().slice(0, 10)}, ${x.score.toFixed(2)})`), '');
    if (!best.length && !worst.length) L.push('Headlines are broadly neutral.', '');
  }

  if (s.technical) {
    const t = s.technical;
    L.push('## Technical snapshot', '');
    L.push(`- Close ₹${t.close.toFixed(2)}, EMA fast ${t.emaFast.toFixed(2)}, EMA slow ${t.emaSlow.toFixed(2)}, EMA trend ${t.emaTrend.toFixed(2)}`);
    L.push(`- RSI ${t.rsi.toFixed(1)}, ATR ₹${t.atr.toFixed(2)}, ${t.aboveTrend ? 'above' : 'below'} the long-term trend`);
    L.push(`- Strategy: ${t.signal}`, '');
  }
  return L.join('\n');
}

/** Ranking summary across all studied companies. */
export function summaryReport(studies: CompanyStudy[], w: Watchlist, now: Date = new Date()): string {
  const onList = new Set(w.entries.map((e) => e.symbol));
  const rows = [...studies].sort((a, b) => b.combinedScore - a.combinedScore);
  return [
    `# Company study, ${now.toISOString().slice(0, 10)}`,
    '',
    `${studies.length} companies studied, ${w.entries.length} on the watchlist. Per-company reports are in this folder.`,
    '',
    '| # | Symbol | Company | Combined | Fundamentals | Sentiment | Screen | Watchlist |',
    '|---:|---|---|---:|---:|---:|:---:|:---:|',
    ...rows.map(
      (s, i) =>
        `| ${i + 1} | [${s.symbol}](./${encodeURIComponent(s.symbol)}.md) | ${s.fundamentals.name} | ${s.combinedScore.toFixed(1)} | ${s.fundamental.score.toFixed(1)} | ${s.sentiment.score.toFixed(2)} | ${s.screen.passed ? '✅' : '❌'} | ${onList.has(s.symbol) ? '⭐' : ''} |`,
    ),
    '',
  ].join('\n');
}
