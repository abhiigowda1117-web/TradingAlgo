import type { ResearchReport } from './research';
import type { Interpretation, Metric, Unit } from './types';

export const NA = 'Not Available';

export function fmt(v: number | null | undefined, unit: Unit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  switch (unit) {
    case 'pct':
      return `${(v * 100).toFixed(1)}%`;
    case 'INR':
      return Math.abs(v) >= 1e7 ? `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr` : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    case 'INR/share':
      return `₹${v.toFixed(2)}`;
    case 'x':
      return `${v.toFixed(1)}x`;
    case 'count':
      return v.toLocaleString('en-IN');
    default:
      return v.toFixed(2);
  }
}

const KIND: Record<Metric['kind'], string> = { reported: 'Reported', calculated: 'Calculated', estimate: 'Estimate', unavailable: NA };

const metricRows = (ms: Metric[]) => [
  '| Metric | Value | Type | Source / formula | As of |',
  '|---|---:|---|---|---|',
  ...ms.map((m) => `| ${m.label} | ${fmt(m.value, m.unit)} | ${KIND[m.kind]} | ${m.kind === 'unavailable' ? '' : (m.formula ?? m.source ?? '') + (m.note ? ` (${m.note})` : '')} | ${m.asOf ?? ''} |`),
];

const bullets = (items: Interpretation[]) => items.map((i) => `- ${i.text}${i.basis.length ? ` _(based on: ${i.basis.join(', ')})_` : ''}`);

export function researchMarkdown(r: ResearchReport): string {
  const o = r.overview;
  const f = r.fundamentals;
  const t = r.technicals;
  const L: string[] = [];
  L.push(`# ${o.name ?? r.symbol} (NSE: ${r.symbol})`, '');
  L.push(`_Generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC. ${r.disclaimer}_`, '');
  L.push('Legend: **Reported** = from a data source as-is · **Calculated** = derived here (formula shown) · **Estimate** = forecast, not fact · **Interpretation** = automated rule-based reading.', '');
  if (r.warnings.length) L.push('> **Data warnings**', ...r.warnings.map((w) => `> - ${w}`), '');

  L.push('## 1. Company overview', '');
  L.push(`| | |`, `|---|---|`);
  L.push(`| Sector | ${o.sector ?? NA} |`, `| Industry | ${o.industry ?? NA} |`, `| Website | ${o.website ?? NA} |`, `| Employees | ${o.employees?.toLocaleString('en-IN') ?? NA} |`);
  L.push(`| Last price | ${fmt(o.price, 'INR/share')} (${o.priceTime ? o.priceTime.slice(0, 16).replace('T', ' ') + ' UTC' : 'time unknown'}; ${o.priceNote}) |`, '');
  L.push('**Business description** (provider text):', '', o.description ?? NA, '');
  L.push(`**Products, services and segments:** ${o.productsAndSegments}`, '');
  if (o.officers.length) L.push('**Key people:** ' + o.officers.map((x) => `${x.name}${x.title ? ` (${x.title})` : ''}`).join('; '), '');

  L.push('## 2. Fundamentals', '');
  L.push(...metricRows(f.metrics), '', '### Growth', '', ...metricRows(f.growth), '');
  const table = (title: string, rows: typeof f.annual) => {
    if (!rows.length) return [`### ${title}`, '', NA, ''];
    return [
      `### ${title} (Reported; margins Calculated)`,
      '',
      '| Period end | Revenue | Operating profit | Net profit | EPS | Op. margin | Net margin | Op. cash flow | Free cash flow | Debt | Equity |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
      ...rows.map(
        (p) =>
          `| ${p.periodEnd} | ${fmt(p.revenue, 'INR')} | ${fmt(p.operatingIncome, 'INR')} | ${fmt(p.netIncome, 'INR')} | ${fmt(p.eps, 'INR/share')} | ${fmt(p.operatingMargin, 'pct')} | ${fmt(p.netMargin, 'pct')} | ${fmt(p.operatingCashFlow, 'INR')} | ${fmt(p.freeCashFlow, 'INR')} | ${fmt(p.totalDebt, 'INR')} | ${fmt(p.equity, 'INR')} |`,
      ),
      '',
    ];
  };
  L.push(...table('Annual trend', f.annual), ...table('Quarterly trend', f.quarterly));

  L.push('## 3. Technical analysis', '');
  if (!t) L.push(NA, '');
  else {
    L.push(`_${t.dataNote} Latest candle: ${t.lastDate ?? NA}._`, '');
    L.push('| Indicator | Value |', '|---|---:|');
    L.push(`| Close | ${fmt(t.lastClose, 'INR/share')} |`, `| EMA 20 / 50 / 200 | ${fmt(t.ema20, 'INR/share')} / ${fmt(t.ema50, 'INR/share')} / ${fmt(t.ema200, 'INR/share')} |`);
    L.push(`| RSI (14) | ${fmt(t.rsi14, 'ratio')} |`, `| MACD / signal / histogram | ${fmt(t.macd.line, 'ratio')} / ${fmt(t.macd.signal, 'ratio')} / ${fmt(t.macd.histogram, 'ratio')} |`);
    L.push(`| 52-week high / low | ${fmt(t.high52, 'INR/share')} / ${fmt(t.low52, 'INR/share')} |`, `| Volume (20d vs 50d avg) | ${t.volume.trend} |`);
    L.push(`| Trend (Calculated) | ${t.trend.trend}: ${t.trend.reason} |`);
    L.push(...t.returns.map((x) => `| Return, ${x.label} | ${fmt(x.value, 'pct')} |`));
    L.push(`| Support levels | ${t.supports.map((l) => `${fmt(l.price, 'INR/share')} (${l.touches}×)`).join(', ') || NA} |`);
    L.push(`| Resistance levels | ${t.resistances.map((l) => `${fmt(l.price, 'INR/share')} (${l.touches}×)`).join(', ') || NA} |`, '');
  }

  L.push('## 4. News and corporate developments', '');
  L.push('### NSE announcements', '');
  if (r.announcements.status === 'ok' && r.announcements.items.length) {
    L.push(...r.announcements.items.slice(0, 15).map((a) => `- ${a.date} · **${a.category}** · ${a.subject}${a.detail ? `: ${a.detail.slice(0, 160)}` : ''}${a.link ? ` ([filing](${a.link}))` : ''}`), '');
  } else L.push(`${NA}${r.announcements.error ? ` (${r.announcements.error})` : ''}. Check the official pages:`, '');
  L.push(...r.announcements.links.map((l) => `- [${l.label}](${l.url})`), '');
  L.push('### Latest news (publishers, not official)', '');
  if (!r.news) L.push(NA, '');
  else {
    L.push(`_${r.news.note}_`, '');
    L.push(...(r.news.items.length ? r.news.items.slice(0, 15).map((n) => `- ${n.date} · ${n.category} · [${n.title}](${n.link}) (${n.source ?? 'n/a'}; tone ${n.sentiment >= 0 ? '+' : ''}${n.sentiment})`) : ['No recent articles found.']), '');
  }

  L.push('## 5. Competitor comparison', '');
  L.push(`_Peers: ${r.peers.basis}. ${r.peers.note}_`, '');
  if (r.peers.rows.length > 1) {
    L.push('| Company | Market cap | Revenue growth | Op. margin | Net margin | ROE | Debt/equity | P/E | P/B |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const p of r.peers.rows) {
      L.push(p.error ? `| ${p.symbol} | ${NA} (${p.error}) | | | | | | | |` : `| ${p.symbol === r.symbol ? `**${p.symbol}**` : p.symbol} | ${fmt(p.marketCap, 'INR')} | ${fmt(p.revenueGrowth, 'pct')} | ${fmt(p.operatingMargin, 'pct')} | ${fmt(p.netMargin, 'pct')} | ${fmt(p.roe, 'pct')} | ${fmt(p.debtToEquity, 'ratio')} | ${fmt(p.pe, 'x')} | ${fmt(p.pb, 'x')} |`);
    }
    const m = r.peers.medians;
    if (m) L.push(`| _Peer median_ | ${fmt(m.marketCap, 'INR')} | ${fmt(m.revenueGrowth, 'pct')} | ${fmt(m.operatingMargin, 'pct')} | ${fmt(m.netMargin, 'pct')} | ${fmt(m.roe, 'pct')} | ${fmt(m.debtToEquity, 'ratio')} | ${fmt(m.pe, 'x')} | ${fmt(m.pb, 'x')} |`);
    L.push('');
  }

  const a = r.assessment;
  L.push('## 6. Research summary (Interpretation, rule-based)', '');
  L.push('_Generated by fixed rules from the figures above. Not a recommendation and not a forecast._', '');
  for (const [title, items] of [
    ['Business quality', a.businessQuality],
    ['Financial strength', a.financialStrength],
    ['Growth', a.growth],
    ['Risks and red flags', a.risks],
    ['Valuation', a.valuation],
    ['Technical outlook (current state, not a prediction)', a.technical],
    ['Bullish scenario: what would need to happen', a.bullish],
    ['Bearish scenario: what would need to happen', a.bearish],
  ] as const) {
    L.push(`### ${title}`, '', ...bullets(items), '');
  }

  L.push('## Sources', '');
  L.push(...r.sources.map((s) => `- ${s.url ? `[${s.name}](${s.url})` : s.name}: retrieved ${s.retrievedAt.slice(0, 16).replace('T', ' ')} UTC${s.asOf ? `, latest data ${s.asOf}` : ''}${s.note ? `. ${s.note}` : ''}`), '');
  return L.join('\n');
}
