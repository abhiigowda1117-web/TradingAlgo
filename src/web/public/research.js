/* Shared research report renderer (local dashboard and web app). Builds DOM with textContent only. */
(function () {
'use strict';
const NA = 'Not Available';
const $ = (id) => document.getElementById(id);
const charts = [];

/** Builds an element; strings become text nodes (never HTML). */
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
function link(url, text) {
  const ok = typeof url === 'string' && /^https?:\/\//i.test(url);
  return ok ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text || url) : el('span', {}, text || NA);
}
function fmt(v, unit) {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  switch (unit) {
    case 'pct': return (v * 100).toFixed(1) + '%';
    case 'INR': return Math.abs(v) >= 1e7 ? '₹' + (v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' cr' : '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
    case 'INR/share': return '₹' + v.toFixed(2);
    case 'x': return v.toFixed(1) + 'x';
    default: return v.toFixed(2);
  }
}
const KIND = { reported: 'Reported', calculated: 'Calculated', estimate: 'Estimate', unavailable: NA };
const badge = (kind) => el('span', { class: 'badge b-' + kind }, KIND[kind] || kind);
const interp = () => el('span', { class: 'badge b-interp' }, 'Interpretation');
const card = (title, ...kids) => el('section', { class: 'card' }, el('h2', {}, title), ...kids);
const signClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

function table(headers, rows, numCols) {
  const nc = new Set(numCols || []);
  return el('table', {},
    el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { class: nc.has(i) ? 'num' : '' }, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', { class: nc.has(i) ? 'num' : '' }, c))))));
}
function metricTable(ms) {
  return table(['Metric', 'Value', 'Type', 'Source / formula', 'As of'],
    ms.map((m) => [m.label, fmt(m.value, m.unit), badge(m.kind), m.kind === 'unavailable' ? '' : (m.formula || m.source || '') + (m.note ? ' (' + m.note + ')' : ''), m.asOf || '']), [1]);
}
function bullets(items) {
  return el('ul', {}, items.map((i) => el('li', {}, i.text, i.basis.length ? el('span', { class: 'muted' }, ' (based on: ' + i.basis.join(', ') + ')') : '')));
}
function chart(type, labels, datasets, opts) {
  if (!window.Chart) return el('p', { class: 'muted' }, 'Chart unavailable (the charting library did not load). The tables show the same data.');
  const canvas = el('canvas');
  const box = el('div', { class: 'chart' }, canvas);
  queueMicrotask(() => charts.push(new Chart(canvas, { type, data: { labels, datasets }, options: Object.assign({ responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { boxWidth: 12 } } }, elements: { point: { radius: 0 } } }, opts || {}) })));
  return box;
}
const crore = (v) => (v === null || v === undefined ? null : v / 1e7);

function render(r, target) {
  charts.splice(0).forEach((c) => c.destroy());
  const o = r.overview, f = r.fundamentals, t = r.technicals, a = r.assessment;
  const out = [];

  out.push(el('section', { class: 'card' },
    el('h2', {}, (o.name || r.symbol) + ' (NSE: ' + r.symbol + ')'),
    el('div', { class: 'muted' }, [o.sector, o.industry].filter(Boolean).join(' · ') || 'Sector Not Available'),
    el('div', { class: 'price' }, fmt(o.price, 'INR/share')),
    el('div', { class: 'muted' }, (o.priceTime ? 'Price time ' + o.priceTime.slice(0, 16).replace('T', ' ') + ' UTC. ' : '') + o.priceNote),
    el('p', { class: 'muted' }, 'Report generated ' + r.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC' + (r.cached ? ' (cached; tick "fetch fresh" to reload)' : '') + '. ' + r.disclaimer),
    el('p', { class: 'muted' }, 'Labels: ', badge('reported'), ' from a data source as-is · ', badge('calculated'), ' derived here, formula shown · ', badge('estimate'), ' forecast, not fact · ', interp(), ' automated rule-based reading · ', badge('unavailable'), ' no data'),
    r.warnings.map((w) => el('div', { class: 'warn' }, w))));

  out.push(card('1. Company overview',
    el('h3', {}, 'Business description (provider text)'), el('p', {}, o.description || NA),
    el('h3', {}, 'Products, services and segments'), el('p', {}, o.productsAndSegments),
    table(['', ''], [['Website', o.website ? link(o.website) : NA], ['Employees', o.employees ? o.employees.toLocaleString('en-IN') : NA], ['Key people', o.officers.length ? o.officers.map((p) => p.name + (p.title ? ' (' + p.title + ')' : '')).join('; ') : NA]])));

  const yr = (p) => p.periodEnd.slice(0, 7);
  out.push(card('2. Fundamentals',
    metricTable(f.metrics), el('h3', {}, 'Growth'), metricTable(f.growth),
    el('div', { class: 'grid' },
      el('div', {}, el('h3', {}, 'Annual revenue and net profit (₹ crore)'), f.annual.length ? chart('bar', f.annual.map(yr), [{ label: 'Revenue', data: f.annual.map((p) => crore(p.revenue)) }, { label: 'Net profit', data: f.annual.map((p) => crore(p.netIncome)) }]) : el('p', {}, NA)),
      el('div', {}, el('h3', {}, 'Quarterly revenue and net profit (₹ crore)'), f.quarterly.length ? chart('bar', f.quarterly.map(yr), [{ label: 'Revenue', data: f.quarterly.map((p) => crore(p.revenue)) }, { label: 'Net profit', data: f.quarterly.map((p) => crore(p.netIncome)) }]) : el('p', {}, NA))),
    ...[['Annual statements', f.annual], ['Quarterly statements', f.quarterly]].map(([title, rows]) => [
      el('h3', {}, title, ' ', badge('reported'), ' margins ', badge('calculated')),
      rows.length ? table(['Period end', 'Revenue', 'Op. profit', 'Net profit', 'EPS', 'Op. margin', 'Net margin', 'Op. cash flow', 'Free cash flow', 'Debt', 'Equity'],
        rows.map((p) => [p.periodEnd, fmt(p.revenue, 'INR'), fmt(p.operatingIncome, 'INR'), fmt(p.netIncome, 'INR'), fmt(p.eps, 'INR/share'), fmt(p.operatingMargin, 'pct'), fmt(p.netMargin, 'pct'), fmt(p.operatingCashFlow, 'INR'), fmt(p.freeCashFlow, 'INR'), fmt(p.totalDebt, 'INR'), fmt(p.equity, 'INR')]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) : el('p', {}, NA)])));

  if (!t) out.push(card('3. Technical analysis', el('p', {}, NA)));
  else {
    const s = t.series, d = s.map((x) => x.date);
    const level = (lv, label) => ({ label, data: d.map(() => lv.price), borderDash: [4, 4], borderWidth: 1 });
    out.push(card('3. Technical analysis',
      el('p', { class: 'muted' }, t.dataNote + ' Latest candle: ' + (t.lastDate || NA) + '.'),
      chart('line', d, [{ label: 'Close', data: s.map((x) => x.close), borderWidth: 2 }, { label: 'EMA 20', data: s.map((x) => x.ema20), borderWidth: 1 }, { label: 'EMA 50', data: s.map((x) => x.ema50), borderWidth: 1 }, { label: 'EMA 200', data: s.map((x) => x.ema200), borderWidth: 1 }, ...t.supports.slice(0, 2).map((l, i) => level(l, 'Support ' + (i + 1))), ...t.resistances.slice(0, 2).map((l, i) => level(l, 'Resistance ' + (i + 1)))]),
      el('div', { class: 'grid' },
        el('div', {}, el('h3', {}, 'Volume'), chart('bar', d, [{ label: 'Volume', data: s.map((x) => x.volume) }], { plugins: { legend: { display: false } } })),
        el('div', {}, el('h3', {}, 'MACD (12, 26, 9)'), chart('line', d, [{ label: 'MACD', data: s.map((x) => x.macd), borderWidth: 1 }, { label: 'Signal', data: s.map((x) => x.signal), borderWidth: 1 }]))),
      table(['Indicator', 'Value', 'Type'], [
        ['Close', fmt(t.lastClose, 'INR/share'), badge('reported')],
        ['EMA 20 / 50 / 200', [t.ema20, t.ema50, t.ema200].map((x) => fmt(x, 'INR/share')).join(' / '), badge('calculated')],
        ['RSI (14)', fmt(t.rsi14), badge('calculated')],
        ['MACD / signal / histogram', [t.macd.line, t.macd.signal, t.macd.histogram].map((x) => fmt(x)).join(' / ') + ' (' + t.macd.state + ')', badge('calculated')],
        ['52-week high / low', fmt(t.high52, 'INR/share') + ' / ' + fmt(t.low52, 'INR/share'), badge('calculated')],
        ['Volume trend', t.volume.trend, badge('calculated')],
        ['Trend', t.trend.trend + ': ' + t.trend.reason, badge('calculated')],
        ...t.returns.map((x) => ['Return, ' + x.label, el('span', { class: signClass(x.value) }, fmt(x.value, 'pct')), badge('calculated')]),
        ['Support levels', t.supports.map((l) => fmt(l.price, 'INR/share') + ' (' + l.touches + '×)').join(', ') || NA, badge('calculated')],
        ['Resistance levels', t.resistances.map((l) => fmt(l.price, 'INR/share') + ' (' + l.touches + '×)').join(', ') || NA, badge('calculated')],
      ], [1])));
  }

  const an = r.announcements;
  out.push(card('4. News and corporate developments',
    el('h3', {}, 'NSE announcements (official disclosures)'),
    an.status === 'ok' && an.items.length
      ? el('ul', {}, an.items.slice(0, 15).map((x) => el('li', {}, x.date + ' · ', el('b', {}, x.category), ' · ' + x.subject + (x.detail ? ': ' + x.detail.slice(0, 160) : ''), x.link ? [' ', link(x.link, '(filing)')] : '')))
      : el('p', {}, NA + (an.error ? ' (' + an.error + ')' : '') + '. Use the official pages:'),
    el('ul', {}, an.links.map((l) => el('li', {}, link(l.url, l.label)))),
    el('h3', {}, 'Latest news (publishers, not official)'),
    !r.news ? el('p', {}, NA) : [
      el('p', { class: 'muted' }, r.news.note),
      r.news.items.length ? el('ul', {}, r.news.items.slice(0, 20).map((n) => el('li', {}, n.date + ' · ' + n.category + ' · ', link(n.link, n.title), ' (' + (n.source || 'n/a') + ') ', el('span', { class: 'badge b-interp ' + signClass(n.sentiment) }, 'tone ' + (n.sentiment >= 0 ? '+' : '') + n.sentiment)))) : el('p', {}, 'No recent articles found.')]));

  const pr = r.peers;
  const prow = (p) => p.error ? [p.symbol, NA + ' (' + p.error + ')', '', '', '', '', '', '', ''] : [p.symbol === r.symbol ? el('b', {}, p.symbol) : p.symbol, fmt(p.marketCap, 'INR'), fmt(p.revenueGrowth, 'pct'), fmt(p.operatingMargin, 'pct'), fmt(p.netMargin, 'pct'), fmt(p.roe, 'pct'), fmt(p.debtToEquity), fmt(p.pe, 'x'), fmt(p.pb, 'x')];
  out.push(card('5. Competitor comparison',
    el('p', { class: 'muted' }, 'Peers: ' + pr.basis + '. ' + pr.note),
    pr.rows.length > 1 ? table(['Company', 'Market cap', 'Revenue growth', 'Op. margin', 'Net margin', 'ROE', 'Debt/equity', 'P/E', 'P/B'],
      [...pr.rows.map(prow), ...(pr.medians ? [[el('i', {}, 'Peer median'), ...prow(Object.assign({ symbol: '' }, pr.medians)).slice(1)]] : [])], [1, 2, 3, 4, 5, 6, 7, 8]) : ''));

  out.push(card('6. Research summary',
    el('p', { class: 'muted' }, interp(), ' Generated by fixed rules from the figures above. Not a recommendation and not a forecast.'),
    ...[['Business quality', a.businessQuality], ['Financial strength', a.financialStrength], ['Growth', a.growth], ['Risks and red flags', a.risks], ['Valuation', a.valuation], ['Technical outlook (current state, not a prediction)', a.technical], ['Bullish scenario: what would need to happen', a.bullish], ['Bearish scenario: what would need to happen', a.bearish]]
      .map(([title, items]) => [el('h3', {}, title), bullets(items)])));

  out.push(card('Sources and data dates',
    el('ul', {}, r.sources.map((s) => el('li', {}, s.url ? link(s.url, s.name) : s.name, ': retrieved ' + s.retrievedAt.slice(0, 16).replace('T', ' ') + ' UTC' + (s.asOf ? ', latest data ' + s.asOf : '') + (s.note ? '. ' + s.note : ''))))));

  (target || $('out')).replaceChildren(...out);
}


window.ResearchUI = { render, el, link, fmt, table, chart, card, badge, interp, signClass, charts, NA };
})();
