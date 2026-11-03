import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { BullBearFight } from '../components/BullBearFight';
import { StockChart } from '../components/StockChart';
import { Bars, TimeChart } from '../components/TimeChart';
import { Badge, Card, Empty, ErrorBox, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { istTime, NA, tone } from '../lib/format';
import type { Interp, Metric, Provenance, ResearchReport, SavedResearch, Unit } from '../lib/researchTypes';
import { useApi } from '../lib/useApi';

const rupee = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const plain = (v: number) => v.toFixed(2);

function fmt(v: number | null | undefined, unit: Unit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  switch (unit) {
    case 'pct': return `${(v * 100).toFixed(1)}%`;
    case 'INR': return Math.abs(v) >= 1e7 ? `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr` : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    case 'INR/share': return `₹${v.toFixed(2)}`;
    case 'x': return `${v.toFixed(1)}x`;
    case 'count': return v.toLocaleString('en-IN');
    default: return v.toFixed(2);
  }
}

const KIND: Record<Provenance, { label: string; color: 'blue' | 'green' | 'amber' | 'gray' }> = {
  reported: { label: 'Reported', color: 'blue' },
  calculated: { label: 'Calculated', color: 'green' },
  estimate: { label: 'Estimate', color: 'amber' },
  unavailable: { label: NA, color: 'gray' },
};
const Kind = ({ k }: { k: Provenance }) => <span className="whitespace-nowrap"><Badge color={KIND[k].color}>{KIND[k].label}</Badge></span>;
const Interpretation = () => <Badge color="blue">Interpretation</Badge>;

/** Only http(s) links are rendered as links. */
const Ext = ({ href, children }: { href?: string; children: ReactNode }) =>
  href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{children}</a> : <span>{children}</span>;

function MetricTable({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Metric</th><th className="num">Value</th><th>Type</th><th>Source / formula</th><th>As of</th></tr></thead>
        <tbody>
          {metrics.map((m) => (
            <tr key={m.key}>
              <td>{m.label}</td>
              <td className={`num whitespace-nowrap ${m.value === null ? 'text-slate-500' : ''}`}>{fmt(m.value, m.unit)}</td>
              <td><Kind k={m.kind} /></td>
              <td className="text-xs text-slate-400">{m.kind === 'unavailable' ? '' : `${m.formula ?? m.source ?? ''}${m.note ? ` (${m.note})` : ''}`}</td>
              <td className="whitespace-nowrap text-xs text-slate-500">{m.asOf ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bullets({ items }: { items: Interp[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((i) => (
        <li key={i.text} className="flex gap-2">
          <span className="text-slate-600">•</span>
          <span>{i.text}{i.basis.length > 0 && <span className="text-xs text-slate-500"> (based on: {i.basis.join(', ')})</span>}</span>
        </li>
      ))}
    </ul>
  );
}

interface LiveQuote {
  symbol: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  previousClose: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  high52: number | null;
  low52: number | null;
  time: string | null;
  fetchedAt: string;
  session: { open: boolean; label: string };
}

/** 30-second poll. Both header parts call it; the server caches quotes for 20 s, so Yahoo sees one request. */
const useLiveQuote = (symbol: string) => useApi<LiveQuote>(`/api/quote?symbol=${encodeURIComponent(symbol)}`, 30_000);
const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--');

/** Price with today's gain or loss, refreshed every 30 seconds. Delayed quotes, labelled as such. */
function LivePrice({ symbol, fallback, fallbackTime }: { symbol: string; fallback: number | null; fallbackTime: string | null }) {
  const { data: q, error } = useLiveQuote(symbol);
  const price = q?.price ?? fallback;
  const up = (q?.change ?? 0) >= 0;
  return (
    <div className="text-right">
      <div key={price ?? 'na'} className="led-flash rounded-md px-1 text-3xl font-semibold tabular-nums">{fmt(price, 'INR/share')}</div>
      {q && q.change !== null && q.changePct !== null ? (
        <div className={`text-base font-semibold tabular-nums ${up ? 'text-up' : 'text-down'}`}>
          {up ? '▲' : '▼'} {up ? '+' : '−'}₹{Math.abs(q.change).toFixed(2)} ({up ? '+' : '−'}{Math.abs(q.changePct).toFixed(2)}%) <span className="text-xs font-normal text-slate-500">today</span>
        </div>
      ) : (
        <div className="text-xs text-slate-500">{error ? `Live price unavailable: ${error}` : 'Loading live price…'}</div>
      )}
      <div className="mt-0.5 flex items-center justify-end gap-1.5 text-xs text-slate-500">
        {q?.session.open ? <span className="led-blink text-up">●</span> : <span className="text-slate-600">●</span>}
        {q ? `Updated ${clock(q.fetchedAt)} IST · refreshes every 30 s` : istTime(fallbackTime)} · delayed ~15 min{q && !q.session.open ? ' · market closed' : ''}
      </div>
    </div>
  );
}

function LiveStats({ symbol }: { symbol: string }) {
  const { data: q } = useLiveQuote(symbol);
  if (!q) return null;
  const cells: [string, string][] = [
    ['Open', fmt(q.open, 'INR/share')],
    ['Prev. close', fmt(q.previousClose, 'INR/share')],
    ['Day low', fmt(q.dayLow, 'INR/share')],
    ['Day high', fmt(q.dayHigh, 'INR/share')],
    ['Volume', q.volume === null ? NA : q.volume.toLocaleString('en-IN')],
    ['52-week range', q.low52 === null || q.high52 === null ? NA : `${fmt(q.low52, 'INR/share')} – ${fmt(q.high52, 'INR/share')}`],
  ];
  return (
    <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map(([k, v]) => (
        <div key={k} className="rounded-lg border border-ink-700/60 bg-ink-850 px-3 py-2">
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="text-sm font-medium tabular-nums text-slate-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Report({ r }: { r: ResearchReport }) {
  const [showChart, setShowChart] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showChart) chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [showChart]);
  const f = r.fundamentals;
  const t = r.technicals;
  const priceLines = useMemo(
    () => (t ? [
      { label: 'Close', color: '#e2e8f0', width: 2 as const, points: t.series.map((p) => ({ time: p.date, value: p.close })) },
      { label: 'EMA 20', color: '#3db8ff', points: t.series.filter((p) => p.ema20 !== null).map((p) => ({ time: p.date, value: p.ema20! })) },
      { label: 'EMA 50', color: '#1e5bff', points: t.series.filter((p) => p.ema50 !== null).map((p) => ({ time: p.date, value: p.ema50! })) },
      { label: 'EMA 200', color: '#94a3b8', points: t.series.filter((p) => p.ema200 !== null).map((p) => ({ time: p.date, value: p.ema200! })) },
    ] : []),
    [t],
  );
  const levels = useMemo(
    () => (t ? [...t.supports.slice(0, 2).map((l, i) => ({ price: l.price, color: '#22c55e', title: `S${i + 1}` })), ...t.resistances.slice(0, 2).map((l, i) => ({ price: l.price, color: '#ef4444', title: `R${i + 1}` }))] : []),
    [t],
  );
  const macdLines = useMemo(
    () => (t ? [
      { label: 'MACD', color: '#3db8ff', points: t.series.filter((p) => p.macd !== null).map((p) => ({ time: p.date, value: p.macd! })) },
      { label: 'Signal', color: '#94a3b8', points: t.series.filter((p) => p.signal !== null).map((p) => ({ time: p.date, value: p.signal! })) },
    ] : []),
    [t],
  );
  const a = r.assessment;
  const peerRow = (p: Omit<ResearchReport['peers']['rows'][number], 'symbol' | 'name'>) => [fmt(p.marketCap, 'INR'), fmt(p.revenueGrowth, 'pct'), fmt(p.operatingMargin, 'pct'), fmt(p.netMargin, 'pct'), fmt(p.roe, 'pct'), fmt(p.debtToEquity, 'ratio'), fmt(p.pe, 'x'), fmt(p.pb, 'x')];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">{r.overview.name ?? r.symbol} <span className="text-base font-normal text-slate-400">NSE: {r.symbol}</span></h2>
            <p className="text-sm text-slate-400">{[r.overview.sector, r.overview.industry].filter(Boolean).join(' · ') || 'Sector Not Available'}</p>
            <button type="button" className="btn mt-3" onClick={() => setShowChart((x) => !x)} aria-expanded={showChart}>
              {showChart ? 'Hide chart' : '📈 View Chart'}
            </button>
          </div>
          <LivePrice symbol={r.symbol} fallback={r.overview.price} fallbackTime={r.overview.priceTime} />
        </div>
        <LiveStats symbol={r.symbol} />
        <p className="mt-3 text-xs text-slate-500">Report generated {istTime(r.generatedAt)}{r.cached ? ' (cached, tick “Fresh data” to reload)' : ''}. {r.disclaimer}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          Labels: <Kind k="reported" /> from a source as-is · <Kind k="calculated" /> derived here, formula shown · <Kind k="estimate" /> forecast · <Interpretation /> rule-based reading · <Kind k="unavailable" /> no data
        </div>
        {r.warnings.map((w) => <p key={w} className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">{w}</p>)}
      </Card>

      {showChart && (
        <div ref={chartRef} className="scroll-mt-16">
          <Card title={`Chart · ${r.symbol}`} action={<button type="button" className="text-xs text-accent" onClick={() => setShowChart(false)}>Close</button>}>
            <StockChart symbol={r.symbol} />
          </Card>
        </div>
      )}

      <Card title="1 · Company overview">
        <p className="text-sm leading-relaxed text-slate-300">{r.overview.description ?? NA}</p>
        <p className="mt-3 text-sm"><span className="text-slate-400">Products, services and segments: </span>{r.overview.productsAndSegments}</p>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          <div><dt className="text-slate-500">Website</dt><dd>{r.overview.website ? <Ext href={r.overview.website}>{r.overview.website}</Ext> : NA}</dd></div>
          <div><dt className="text-slate-500">Employees</dt><dd>{r.overview.employees?.toLocaleString('en-IN') ?? NA}</dd></div>
          <div><dt className="text-slate-500">Key people</dt><dd>{r.overview.officers.length ? r.overview.officers.map((o) => `${o.name}${o.title ? ` (${o.title})` : ''}`).join('; ') : NA}</dd></div>
        </dl>
      </Card>

      <Card title="2 · Fundamentals">
        <MetricTable metrics={f.metrics} />
        <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-300">Growth</h3>
        <MetricTable metrics={f.growth} />
        <div className="mt-5 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          {([['Annual revenue & net profit', f.annual], ['Quarterly revenue & net profit', f.quarterly]] as const).map(([title, rows]) => (
            <div key={title}>
              <h3 className="mb-2 text-sm font-semibold text-slate-300">{title} <span className="font-normal text-slate-500">(Reported)</span></h3>
              {rows.length ? <Bars periods={rows.map((p) => p.periodEnd)} series={[{ label: 'Revenue', color: '#2f7dff', values: rows.map((p) => p.revenue) }, { label: 'Net profit', color: '#22c55e', values: rows.map((p) => p.netIncome) }]} /> : <Empty>{NA}</Empty>}
            </div>
          ))}
        </div>
        {f.annual.length > 0 && (
          <div className="mt-5 overflow-x-auto">
            <table className="table">
              <thead><tr><th>Year end</th><th className="num">Revenue</th><th className="num">Op. profit</th><th className="num">Net profit</th><th className="num">EPS</th><th className="num">Op. margin</th><th className="num">Net margin</th><th className="num">Op. cash flow</th><th className="num">Free cash flow</th><th className="num">Debt</th></tr></thead>
              <tbody>{f.annual.map((p) => <tr key={p.periodEnd}><td>{p.periodEnd}</td><td className="num">{fmt(p.revenue, 'INR')}</td><td className="num">{fmt(p.operatingIncome, 'INR')}</td><td className="num">{fmt(p.netIncome, 'INR')}</td><td className="num">{fmt(p.eps, 'INR/share')}</td><td className="num">{fmt(p.operatingMargin, 'pct')}</td><td className="num">{fmt(p.netMargin, 'pct')}</td><td className="num">{fmt(p.operatingCashFlow, 'INR')}</td><td className="num">{fmt(p.freeCashFlow, 'INR')}</td><td className="num">{fmt(p.totalDebt, 'INR')}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="3 · Technical analysis">
        {!t ? <Empty>{NA}</Empty> : (
          <>
            <p className="mb-2 text-xs text-slate-500">{t.dataNote} Latest candle {t.lastDate ?? NA}. Dashed lines: S = support, R = resistance (calculated from swing points).</p>
            <TimeChart lines={priceLines} levels={levels} height={340} format={rupee} />
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="min-w-0">
                <h3 className="mb-2 text-sm font-semibold text-slate-300">MACD (12, 26, 9)</h3>
                <TimeChart lines={macdLines} height={180} format={plain} />
              </div>
              <div className="min-w-0 overflow-x-auto">
              <table className="table">
                <tbody>
                  <tr><td className="text-slate-400">Trend</td><td><b>{t.trend.trend}</b> <span className="text-xs text-slate-500">{t.trend.reason}</span></td></tr>
                  <tr><td className="text-slate-400">EMA 20 / 50 / 200</td><td className="tabular-nums">{[t.ema20, t.ema50, t.ema200].map((x) => fmt(x, 'INR/share')).join(' / ')}</td></tr>
                  <tr><td className="text-slate-400">RSI (14)</td><td>{fmt(t.rsi14, 'ratio')} {t.rsi14 !== null && <span className="text-xs text-slate-500">{t.rsi14 > 70 ? 'overbought zone' : t.rsi14 < 30 ? 'oversold zone' : 'neutral'}</span>}</td></tr>
                  <tr><td className="text-slate-400">MACD</td><td>{t.macd.state}</td></tr>
                  <tr><td className="text-slate-400">Volume</td><td>{t.volume.trend}</td></tr>
                  <tr><td className="text-slate-400">52-week range</td><td className="tabular-nums">{fmt(t.low52, 'INR/share')} – {fmt(t.high52, 'INR/share')}</td></tr>
                  <tr><td className="text-slate-400">Returns</td><td>{t.returns.map((x) => <span key={x.label} className={`mr-3 whitespace-nowrap ${tone(x.value)}`}>{x.label} {fmt(x.value, 'pct')}</span>)}</td></tr>
                  <tr><td className="text-slate-400">Support / resistance</td><td className="tabular-nums">{t.supports.map((l) => fmt(l.price, 'INR/share')).join(', ') || NA} / {t.resistances.map((l) => fmt(l.price, 'INR/share')).join(', ') || NA}</td></tr>
                </tbody>
              </table>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card title="4 · News and corporate developments">
        <h3 className="mb-2 text-sm font-semibold text-slate-300">NSE announcements <span className="font-normal text-slate-500">(official disclosures)</span></h3>
        {r.announcements.status === 'ok' && r.announcements.items.length ? (
          <ul className="space-y-1 text-sm">{r.announcements.items.slice(0, 12).map((x, i) => <li key={i}><span className="text-slate-500">{x.date}</span> · <b>{x.category}</b> · {x.subject}{x.detail ? <span className="text-slate-400">: {x.detail.slice(0, 160)}</span> : null} {x.link && <Ext href={x.link}>(filing)</Ext>}</li>)}</ul>
        ) : (
          <p className="text-sm text-slate-400">{NA}{r.announcements.error ? ` (${r.announcements.error})` : ''}. Check the official pages:</p>
        )}
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">{r.announcements.links.map((l) => <li key={l.url}><Ext href={l.url}>{l.label}</Ext></li>)}</ul>
        <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-300">Latest news <span className="font-normal text-slate-500">(publishers, not official)</span></h3>
        {!r.news ? <Empty>{NA}</Empty> : r.news.items.length === 0 ? <Empty>No recent articles found.</Empty> : (
          <ul className="space-y-1.5 text-sm">{r.news.items.slice(0, 20).map((n, i) => (
            <li key={i}><span className="text-slate-500">{n.date}</span> · {n.category} · <Ext href={n.link}>{n.title}</Ext> <span className="text-slate-500">({n.source ?? 'n/a'})</span> <span className={`text-xs ${tone(n.sentiment)}`}>tone {n.sentiment >= 0 ? '+' : ''}{n.sentiment}</span></li>
          ))}</ul>
        )}
        {r.news && <p className="mt-2 text-xs text-slate-500">{r.news.note}</p>}
      </Card>

      <Card title="5 · Competitor comparison">
        <p className="mb-2 text-xs text-slate-500">Peers: {r.peers.basis}. {r.peers.note}</p>
        {r.peers.rows.length > 1 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Company</th><th className="num">Market cap</th><th className="num">Rev. growth</th><th className="num">Op. margin</th><th className="num">Net margin</th><th className="num">ROE</th><th className="num">Debt/equity</th><th className="num">P/E</th><th className="num">P/B</th></tr></thead>
              <tbody>
                {r.peers.rows.map((p) => (
                  <tr key={p.symbol} className={p.symbol === r.symbol ? 'bg-ink-850' : ''}>
                    <td><b>{p.symbol}</b><div className="text-xs text-slate-500">{p.error ? `${NA}: ${p.error}` : p.name}</div></td>
                    {(p.error ? Array(8).fill('') : peerRow(p)).map((v, i) => <td key={i} className="num">{v}</td>)}
                  </tr>
                ))}
                {r.peers.medians && <tr className="italic text-slate-400"><td>Peer median</td>{peerRow(r.peers.medians).map((v, i) => <td key={i} className="num">{v}</td>)}</tr>}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2">6 · Research summary <Interpretation /></span>}>
        <p className="mb-3 text-xs text-slate-500">Generated by fixed rules from the figures above. Not a recommendation and not a forecast.</p>
        <div className="grid gap-5 lg:grid-cols-2">
          {([['Business quality', a.businessQuality], ['Financial strength', a.financialStrength], ['Growth', a.growth], ['Risks and red flags', a.risks], ['Valuation', a.valuation], ['Technical outlook (current state)', a.technical], ['Bullish scenario: what would need to happen', a.bullish], ['Bearish scenario: what would need to happen', a.bearish]] as const).map(([title, items]) => (
            <div key={title}><h3 className="mb-1.5 text-sm font-semibold text-slate-300">{title}</h3><Bullets items={items} /></div>
          ))}
        </div>
      </Card>

      <Card title="Sources and data dates">
        <ul className="space-y-1 text-sm">{r.sources.map((s) => <li key={s.name}><Ext href={s.url}>{s.name}</Ext> <span className="text-slate-500">· retrieved {istTime(s.retrievedAt)}{s.asOf ? ` · latest data ${s.asOf}` : ''}{s.note ? ` · ${s.note}` : ''}</span></li>)}</ul>
      </Card>
    </div>
  );
}

export function Research() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [peers, setPeers] = useState(params.get('peers') ?? '');
  const [fresh, setFresh] = useState(false);
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [won, setWon] = useState(false);
  const recent = useApi<SavedResearch[]>('/api/research/recent');

  // The address bar (?q=...&peers=...) is the source of truth: every new search adds a history entry, so
  // the browser's Back button (and the ← Back button in the header) returns to the previous company.
  const qParam = params.get('q') ?? '';
  const pParam = params.get('peers') ?? '';
  const lastRun = useRef('');
  const latest = useRef(0);
  const wantFresh = useRef(false);

  async function run(q: string, p: string, refresh: boolean) {
    if (!q.trim()) return;
    const token = ++latest.current;
    lastRun.current = `${q}|${p}`;
    setBusy(true);
    setError(null);
    const qs = new URLSearchParams({ q: q.trim() });
    if (p.trim()) qs.set('peers', p.trim().toUpperCase());
    if (refresh) qs.set('refresh', '1');
    try {
      const r = await api<ResearchReport>(`/api/research?${qs}`);
      if (token !== latest.current) return; // a newer search started; drop this result
      // Finale: the bull wins, then the report opens. Skipped for cached reports (e.g. going Back) and
      // when the user prefers reduced motion.
      if (!r.cached && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setWon(true);
        await new Promise((res) => setTimeout(res, 1700));
        if (token !== latest.current) return;
      }
      setReport(r);
      void recent.reload();
    } catch (e) {
      if (token !== latest.current) return;
      const msg = (e as Error).message;
      // A bare "Not found" means the running server predates this page: it has no research route yet.
      setError(msg === 'Not found' ? 'The server is running an older version without Company Research. Stop it (Ctrl + C) and start it again with: npm.cmd run server' : msg);
    } finally {
      if (token === latest.current) {
        setBusy(false);
        setWon(false);
      }
    }
  }

  // Run whenever the address changes: first load, a new search, a Recent chip, or Back/Forward.
  useEffect(() => {
    if (!qParam) {
      latest.current++;
      lastRun.current = '';
      setReport(null);
      setError(null);
      setBusy(false);
      return;
    }
    if (`${qParam}|${pParam}` === lastRun.current && !wantFresh.current) return;
    setQuery(qParam);
    setPeers(pParam);
    const refresh = wantFresh.current;
    wantFresh.current = false;
    void run(qParam, pParam, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam, pParam]);

  const open = (q: string, p: string, refresh: boolean) => {
    const next = { q: q.trim(), p: p.trim().toUpperCase() };
    if (!next.q) return;
    if (next.q === qParam && next.p === pParam) {
      void run(next.q, next.p, refresh); // same company again (e.g. with Fresh data)
      return;
    }
    wantFresh.current = refresh;
    setParams(next.p ? { q: next.q, peers: next.p } : { q: next.q }); // pushes a history entry
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    open(query, peers, fresh);
  };

  return (
    <>
      <PageHeader title="Company Research" description="Any NSE-listed company: fundamentals, technicals, news, NSE announcements, peers and a rule-based summary. Research only; it never places orders." />
      <Card>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem] flex-1 text-sm">
            <span className="mb-1 block text-slate-400">Company name or NSE symbol</span>
            <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Reliance, BEL, HDFC Bank" maxLength={60} required />
          </label>
          <label className="min-w-[12rem] text-sm">
            <span className="mb-1 block text-slate-400">Peers (optional)</span>
            <input className="input uppercase placeholder:normal-case" value={peers} onChange={(e) => setPeers(e.target.value)} placeholder="ONGC,BPCL,IOC" maxLength={130} />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-400"><input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> Fresh data</label>
          <button className="btn" disabled={busy}>{busy ? 'Researching…' : 'Analyze'}</button>
        </form>
        {recent.data && recent.data.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">Recent:</span>
            {recent.data.map((s) => (
              <button key={s.symbol} type="button" className="rounded-full border border-ink-700 px-2.5 py-1 text-slate-300 hover:bg-ink-800" title={`${s.name ?? s.symbol} · ${istTime(s.generatedAt)}`} onClick={() => open(s.symbol, '', false)}>
                {s.symbol}
              </button>
            ))}
          </div>
        )}
      </Card>
      <div className="mt-4">
        {busy && <BullBearFight finished={won} label={won ? 'Report ready.' : 'Researching… this takes 10–40 seconds (profile, statements, prices, news, NSE announcements and peers).'} />}
        {!busy && error && <ErrorBox message={error} />}
        {!busy && !error && report && <Report r={report} />}
        {!busy && !error && !report && <Empty>Type a company and click Analyze. Example: <b>Reliance</b>, <b>Bharat Electronics</b> or <b>TCS</b>.</Empty>}
      </div>
    </>
  );
}
