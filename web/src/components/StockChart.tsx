import {
  ColorType,
  createChart,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bollinger, ema, heikinAshi, macd, rsi, sma, supertrend, vwap, type Bar, type Series } from '../lib/indicators';
import { useApi } from '../lib/useApi';

/**
 * Interactive stock chart in the style of a broker terminal: intervals from 1 minute to 1 month,
 * candles / Heikin-Ashi / OHLC bars / line / area, volume, moving averages, Bollinger Bands, VWAP,
 * Supertrend, RSI and MACD panes, an OHLC readout on hover, horizontal and trend-line drawing, log
 * scale and fullscreen. Read-only: there are no order buttons. Data is delayed (Yahoo Finance).
 */

type Interval = '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1w' | '1mo';
type ChartType = 'candles' | 'heikin' | 'bars' | 'line' | 'area';
type Tool = 'cursor' | 'hline' | 'trend';
type IndKey = 'vol' | 'sma20' | 'sma50' | 'sma200' | 'ema9' | 'ema21' | 'bb' | 'vwap' | 'st' | 'rsi' | 'macd';

const INTERVALS: { key: Interval; label: string; ranges: string[]; def: string }[] = [
  { key: '1m', label: '1m', ranges: ['1D', '5D'], def: '1D' },
  { key: '5m', label: '5m', ranges: ['1D', '5D', '1M'], def: '5D' },
  { key: '15m', label: '15m', ranges: ['1D', '5D', '1M'], def: '5D' },
  { key: '30m', label: '30m', ranges: ['5D', '1M'], def: '1M' },
  { key: '1h', label: '1H', ranges: ['1M', '3M', '6M', '1Y'], def: '3M' },
  { key: '1d', label: 'D', ranges: ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'MAX'], def: '1Y' },
  { key: '1w', label: 'W', ranges: ['1Y', '3Y', '5Y', 'MAX'], def: '5Y' },
  { key: '1mo', label: 'M', ranges: ['5Y', 'MAX'], def: 'MAX' },
];
const TYPES: { key: ChartType; label: string }[] = [
  { key: 'candles', label: 'Candles' },
  { key: 'heikin', label: 'Heikin-Ashi' },
  { key: 'bars', label: 'OHLC bars' },
  { key: 'line', label: 'Line' },
  { key: 'area', label: 'Area' },
];
const INDICATORS: { key: IndKey; label: string; color: string; pane?: boolean; intradayOnly?: boolean }[] = [
  { key: 'vol', label: 'Volume', color: '#64748b' },
  { key: 'sma20', label: 'SMA 20', color: '#facc15' },
  { key: 'sma50', label: 'SMA 50', color: '#38bdf8' },
  { key: 'sma200', label: 'SMA 200', color: '#e879f9' },
  { key: 'ema9', label: 'EMA 9', color: '#fb923c' },
  { key: 'ema21', label: 'EMA 21', color: '#a3e635' },
  { key: 'bb', label: 'Bollinger Bands (20, 2)', color: '#94a3b8' },
  { key: 'vwap', label: 'VWAP (intraday)', color: '#f59e0b', intradayOnly: true },
  { key: 'st', label: 'Supertrend (10, 3)', color: '#22c55e' },
  { key: 'rsi', label: 'RSI (14)', color: '#3db8ff', pane: true },
  { key: 'macd', label: 'MACD (12, 26, 9)', color: '#3db8ff', pane: true },
];
const UP = '#22c55e';
const DOWN = '#ef4444';
const DRAW = '#00c2ff';

interface ChartData {
  symbol: string;
  interval: Interval;
  range: string;
  intraday: boolean;
  candles: Bar[];
  session: { open: boolean; label: string };
  fetchedAt: string;
  dataNote: string;
  source?: { provider: 'kite' | 'yahoo'; live: boolean; label: string; warning?: string };
}
type Point = { time: Time; price: number };
type Drawing = { kind: 'h'; price: number } | { kind: 't'; interval: Interval; a: Point; b: Point };

const fmt = (v: number | null | undefined, dp = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const vol = (v: number) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** All indicator series for the enabled set, aligned with the candles by index. */
function compute(bars: Bar[], on: Set<IndKey>, intraday: boolean) {
  const c = bars.map((b) => b.close);
  return {
    sma20: on.has('sma20') ? sma(c, 20) : null,
    sma50: on.has('sma50') ? sma(c, 50) : null,
    sma200: on.has('sma200') ? sma(c, 200) : null,
    ema9: on.has('ema9') ? ema(c, 9) : null,
    ema21: on.has('ema21') ? ema(c, 21) : null,
    bb: on.has('bb') ? bollinger(c, 20, 2) : null,
    vwap: on.has('vwap') && intraday ? vwap(bars) : null,
    st: on.has('st') ? supertrend(bars, 10, 3) : null,
    rsi: on.has('rsi') ? rsi(c, 14) : null,
    macd: on.has('macd') ? macd(c, 12, 26, 9) : null,
  };
}

/** Line data with whitespace where the indicator is undefined, so every pane has one point per bar. */
const toLine = (bars: Bar[], values: Series) => bars.map((b, i) => (values[i] === null || values[i] === undefined ? { time: b.time as Time } : { time: b.time as Time, value: values[i]! }));

export function StockChart({ symbol }: { symbol: string }) {
  const [iv, setIv] = useState<Interval>('1d');
  const [range, setRange] = useState('1Y');
  const [type, setType] = useState<ChartType>('candles');
  const [on, setOn] = useState<Set<IndKey>>(() => new Set<IndKey>(['vol']));
  const [tool, setTool] = useState<Tool>('cursor');
  const [log, setLog] = useState(false);
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [pending, setPending] = useState<Point | null>(null);

  const spec = INTERVALS.find((i) => i.key === iv)!;
  const intraday = ['1m', '5m', '15m', '30m', '1h'].includes(iv);
  const { data, error, loading } = useApi<ChartData>(`/api/chart?symbol=${encodeURIComponent(symbol)}&interval=${iv}&range=${range}`, intraday ? 30_000 : 300_000);
  const bars = data && data.interval === iv && data.range === range && data.symbol === symbol ? data.candles : null;
  const onKey = [...on].sort().join(',');
  const calc = useMemo(() => (bars ? compute(bars, on, intraday) : null), [bars, onKey, intraday]); // eslint-disable-line react-hooks/exhaustive-deps

  const mainBox = useRef<HTMLDivElement>(null);
  const rsiBox = useRef<HTMLDivElement>(null);
  const macdBox = useRef<HTMLDivElement>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const view = useRef<{ key: string; range: LogicalRange | null }>({ key: '', range: null });

  // Esc leaves fullscreen or cancels a drawing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setTool('cursor');
      setPending(null);
      setFull(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!bars || !calc || !mainBox.current || bars.length === 0) return;
    const fitKey = `${symbol}|${iv}|${range}`;
    const hasRsi = on.has('rsi');
    const hasMacd = on.has('macd');
    const make = (el: HTMLElement, showTime: boolean, extra: Parameters<typeof createChart>[1] = {}) =>
      createChart(el, {
        autoSize: true,
        layout: { background: { type: ColorType.Solid, color: '#000000' }, textColor: '#8b95b3', fontSize: 11 },
        grid: { vertLines: { color: '#0d1220' }, horzLines: { color: '#0d1220' } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1c2340', minimumWidth: 78 },
        timeScale: { borderColor: '#1c2340', timeVisible: intraday, secondsVisible: false, rightOffset: 6, visible: showTime, lockVisibleTimeRangeOnResize: true },
        ...extra,
      });

    const main = make(mainBox.current, !hasRsi && !hasMacd, { watermark: { visible: true, text: symbol, color: 'rgba(47, 125, 255, 0.08)', fontSize: 56 } });
    main.priceScale('right').applyOptions({ mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, scaleMargins: on.has('vol') ? { top: 0.08, bottom: 0.22 } : { top: 0.08, bottom: 0.06 } });
    const src = type === 'heikin' ? heikinAshi(bars) : bars;
    let price: ISeriesApi<SeriesType>;
    if (type === 'candles' || type === 'heikin') {
      price = main.addCandlestickSeries({ upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN });
      price.setData(src.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
    } else if (type === 'bars') {
      price = main.addBarSeries({ upColor: UP, downColor: DOWN, thinBars: false });
      price.setData(src.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
    } else if (type === 'line') {
      price = main.addLineSeries({ color: '#3db8ff', lineWidth: 2 });
      price.setData(src.map((b) => ({ time: b.time as Time, value: b.close })));
    } else {
      price = main.addAreaSeries({ lineColor: '#3db8ff', topColor: 'rgba(61, 184, 255, 0.35)', bottomColor: 'rgba(61, 184, 255, 0.02)', lineWidth: 2 });
      price.setData(src.map((b) => ({ time: b.time as Time, value: b.close })));
    }
    if (on.has('vol')) {
      const v = main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      v.setData(bars.map((b) => ({ time: b.time as Time, value: b.volume, color: b.close >= b.open ? 'rgba(34, 197, 94, 0.35)' : 'rgba(239, 68, 68, 0.35)' })));
    }
    const overlay = (values: Series | null, color: string, style: LineStyle = LineStyle.Solid, width: 1 | 2 = 1) => {
      if (!values) return;
      const s = main.addLineSeries({ color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(toLine(bars, values));
    };
    overlay(calc.sma20, '#facc15');
    overlay(calc.sma50, '#38bdf8');
    overlay(calc.sma200, '#e879f9');
    overlay(calc.ema9, '#fb923c');
    overlay(calc.ema21, '#a3e635');
    if (calc.bb) {
      overlay(calc.bb.upper, '#94a3b8');
      overlay(calc.bb.mid, '#94a3b8', LineStyle.Dashed);
      overlay(calc.bb.lower, '#94a3b8');
    }
    overlay(calc.vwap, '#f59e0b', LineStyle.Solid, 2);
    if (calc.st) {
      const st = calc.st;
      const s = main.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(bars.map((b, i) => (st.value[i] === null ? { time: b.time as Time } : { time: b.time as Time, value: st.value[i]!, color: st.dir[i] === 1 ? UP : DOWN })));
    }

    // Drawings: horizontal lines survive interval changes; trend lines belong to the interval they were drawn on.
    for (const d of drawings) {
      if (d.kind === 'h') price.createPriceLine({ price: d.price, color: DRAW, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' });
      else if (d.interval === iv && d.a.time !== d.b.time) {
        const pts = [d.a, d.b].sort((x, y) => (x.time < y.time ? -1 : 1));
        const s = main.addLineSeries({ color: DRAW, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        s.setData(pts.map((p) => ({ time: p.time, value: p.price })));
      }
    }

    // Lower panes, each with one point per bar so the time scales line up by index.
    const subs: { chart: IChartApi; series: ISeriesApi<SeriesType>; values: Series }[] = [];
    if (hasRsi && calc.rsi && rsiBox.current) {
      const c = make(rsiBox.current, !hasMacd);
      const s = c.addLineSeries({ color: '#3db8ff', lineWidth: 1, priceLineVisible: false });
      s.setData(toLine(bars, calc.rsi));
      s.createPriceLine({ price: 70, color: DOWN, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      s.createPriceLine({ price: 30, color: UP, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      subs.push({ chart: c, series: s, values: calc.rsi });
    }
    if (hasMacd && calc.macd && macdBox.current) {
      const m = calc.macd;
      const c = make(macdBox.current, true);
      const h = c.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      h.setData(bars.map((b, i) => (m.hist[i] === null ? { time: b.time as Time } : { time: b.time as Time, value: m.hist[i]!, color: m.hist[i]! >= 0 ? 'rgba(34, 197, 94, 0.6)' : 'rgba(239, 68, 68, 0.6)' })));
      const line = c.addLineSeries({ color: '#3db8ff', lineWidth: 1, priceLineVisible: false });
      line.setData(toLine(bars, m.macd));
      const sig = c.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false });
      sig.setData(toLine(bars, m.signal));
      subs.push({ chart: c, series: line, values: m.macd });
    }

    // Keep panes scrolled and zoomed together, and share the crosshair.
    const all = [main, ...subs.map((s) => s.chart)];
    let syncingRange = false;
    for (const from of all) {
      from.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (syncingRange || !r) return;
        syncingRange = true;
        for (const to of all) if (to !== from) to.timeScale().setVisibleLogicalRange(r);
        syncingRange = false;
      });
    }
    const index = new Map(bars.map((b, i) => [b.time, i]));
    let syncingCross = false;
    const crossTo = (time: Time | undefined, except: IChartApi | null) => {
      const i = time === undefined ? undefined : index.get(time as number | string);
      setHover(i ?? null);
      syncingCross = true;
      const targets: { chart: IChartApi; series: ISeriesApi<SeriesType>; value: number | null }[] = [
        { chart: main, series: price, value: i === undefined ? null : bars[i]!.close },
        ...subs.map((s) => ({ chart: s.chart, series: s.series, value: i === undefined ? null : s.values[i] ?? null })),
      ];
      for (const t of targets) {
        if (t.chart === except) continue;
        if (time !== undefined && t.value !== null) t.chart.setCrosshairPosition(t.value, time, t.series);
        else t.chart.clearCrosshairPosition();
      }
      syncingCross = false;
    };
    for (const c of all) c.subscribeCrosshairMove((p) => !syncingCross && crossTo(p.time, c));

    // Drawing tools. Native click events on the chart element (the chart library merges two quick clicks
    // into one double-click, which would lose the second point). A press that moved more than a few
    // pixels was a pan, not a click. Refs are updated at once so one click is never counted twice.
    const el = mainBox.current;
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const onClick = (e: MouseEvent) => {
      const t = toolRef.current;
      if (t === 'cursor') return;
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
      const r = el.getBoundingClientRect();
      const time = main.timeScale().coordinateToTime(e.clientX - r.left);
      const at = price.coordinateToPrice(e.clientY - r.top);
      if (time === null || at === null) return;
      if (t === 'hline') {
        toolRef.current = 'cursor';
        setDrawings((d) => [...d, { kind: 'h', price: at }]);
        setTool('cursor');
      } else if (!pendingRef.current) {
        pendingRef.current = { time, price: at };
        setPending(pendingRef.current);
      } else if (pendingRef.current.time !== time) {
        const a = pendingRef.current;
        pendingRef.current = null;
        toolRef.current = 'cursor';
        setDrawings((d) => [...d, { kind: 't', interval: iv, a, b: { time, price: at } }]);
        setPending(null);
        setTool('cursor');
      }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('click', onClick);

    // Keep the user's zoom across refreshes and redraws; fit when the symbol, interval or range changes.
    if (view.current.key === fitKey && view.current.range) main.timeScale().setVisibleLogicalRange(view.current.range);
    else main.timeScale().fitContent();
    view.current.key = fitKey;

    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('click', onClick);
      view.current.range = main.timeScale().getVisibleLogicalRange();
      for (const c of all) c.remove();
    };
  }, [bars, calc, type, log, drawings, iv, range, symbol, intraday, onKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickInterval = (k: Interval) => {
    const s = INTERVALS.find((i) => i.key === k)!;
    setIv(k);
    if (!s.ranges.includes(range)) setRange(s.def);
    setPending(null);
  };
  const toggle = (k: IndKey) =>
    setOn((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  // Legend: hovered bar, or the latest one.
  const i = bars ? (hover ?? bars.length - 1) : null;
  const b = bars && i !== null ? bars[i] : null;
  const prev = bars && i !== null && i > 0 ? bars[i - 1] : null;
  const chg = b && prev ? b.close - prev.close : null;
  const chgPct = chg !== null && prev ? (chg / prev.close) * 100 : null;
  const val = (s: Series | null | undefined) => (s && i !== null ? s[i] : null);
  const legend: { label: string; color: string; text: string }[] = [];
  if (calc && i !== null) {
    for (const [k, label, color] of [['sma20', 'SMA 20', '#facc15'], ['sma50', 'SMA 50', '#38bdf8'], ['sma200', 'SMA 200', '#e879f9'], ['ema9', 'EMA 9', '#fb923c'], ['ema21', 'EMA 21', '#a3e635'], ['vwap', 'VWAP', '#f59e0b']] as const) {
      const s = calc[k];
      if (s) legend.push({ label, color, text: fmt(val(s)) });
    }
    if (calc.bb) legend.push({ label: 'BB 20 2', color: '#94a3b8', text: `${fmt(val(calc.bb.upper))} / ${fmt(val(calc.bb.mid))} / ${fmt(val(calc.bb.lower))}` });
    if (calc.st) legend.push({ label: 'Supertrend', color: calc.st.dir[i] === -1 ? DOWN : UP, text: fmt(val(calc.st.value)) });
  }

  const btn = (active: boolean) => `rounded-md px-2 py-1 text-xs font-medium transition ${active ? 'bg-accent/25 text-white ring-1 ring-inset ring-accent/60' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200'}`;
  const hint = tool === 'hline' ? 'Click on the chart to place a horizontal line (Esc to cancel).' : tool === 'trend' ? (pending ? 'Click the second point of the trend line.' : 'Click the first point of the trend line (Esc to cancel).') : null;

  return (
    <div className={full ? 'fixed inset-0 z-50 flex flex-col bg-black p-2 sm:p-3' : 'flex flex-col'}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-800 pb-2">
        <div className="flex flex-wrap gap-0.5" role="group" aria-label="Interval">
          {INTERVALS.map((x) => (
            <button key={x.key} type="button" className={btn(iv === x.key)} onClick={() => pickInterval(x.key)} title={`${x.label} candles`}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-0.5" role="group" aria-label="Range">
          {spec.ranges.map((r) => (
            <button key={r} type="button" className={btn(range === r)} onClick={() => setRange(r)}>
              {r === 'MAX' ? 'Max' : r}
            </button>
          ))}
        </div>
        <select className="rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-slate-200" value={type} onChange={(e) => setType(e.target.value as ChartType)} aria-label="Chart type">
          {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <details className="relative">
          <summary className="cursor-pointer list-none rounded-md border border-ink-700 px-2 py-1 text-xs text-slate-200 hover:bg-ink-800">
            Indicators{on.size ? ` (${on.size})` : ''} ▾
          </summary>
          <div className="absolute left-0 z-20 mt-1 w-60 rounded-lg border border-ink-700 bg-ink-900 p-2 shadow-xl">
            {INDICATORS.map((x) => (
              <label key={x.key} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-ink-800 ${x.intradayOnly && !intraday ? 'opacity-50' : ''}`}>
                <input type="checkbox" checked={on.has(x.key)} onChange={() => toggle(x.key)} />
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: x.color }} />
                <span className="text-slate-200">{x.label}</span>
                {x.pane && <span className="ml-auto text-[10px] text-slate-500">pane</span>}
              </label>
            ))}
            <p className="mt-1 px-2 text-[10px] text-slate-500">VWAP needs a minute or hour interval.</p>
          </div>
        </details>
        <div className="flex gap-0.5" role="group" aria-label="Drawing tools">
          <button type="button" className={btn(tool === 'cursor')} onClick={() => { setTool('cursor'); setPending(null); }} title="Crosshair">✛</button>
          <button type="button" className={btn(tool === 'hline')} onClick={() => { setTool('hline'); setPending(null); }} title="Horizontal line">― H-line</button>
          <button type="button" className={btn(tool === 'trend')} onClick={() => { setTool('trend'); setPending(null); }} title="Trend line">╱ Trend</button>
          <button type="button" className={btn(false)} onClick={() => { setDrawings([]); setPending(null); }} title="Remove all drawings" disabled={!drawings.length}>Clear</button>
        </div>
        <div className="ml-auto flex gap-0.5">
          <button type="button" className={btn(log)} onClick={() => setLog((x) => !x)} title="Logarithmic price scale">Log</button>
          <button type="button" className={btn(full)} onClick={() => setFull((x) => !x)} title={full ? 'Exit fullscreen (Esc)' : 'Fullscreen'}>{full ? '✕ Exit' : '⛶ Full'}</button>
        </div>
      </div>
      <p className="mt-1 h-4 text-xs text-accent" aria-live="polite">{hint ?? ''}</p>

      {/* Main chart with the OHLC legend on top */}
      <div className={`relative mt-2 ${full ? 'min-h-0 flex-1' : 'h-[300px] sm:h-[440px]'}`}>
        <div ref={mainBox} className={`absolute inset-0 ${tool !== 'cursor' ? 'cursor-crosshair' : ''}`} />
        <div className="pointer-events-none absolute left-2 top-1 z-10 max-w-[calc(100%-6rem)] space-y-0.5 text-[11px] leading-tight">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-slate-100">{symbol}</span>
            <span className="text-slate-500">{spec.label} · NSE</span>
            {b && (
              <span className="tabular-nums">
                <span className="text-slate-500">O</span> <span className={chg !== null && chg < 0 ? 'text-down' : 'text-up'}>{fmt(b.open)}</span>{' '}
                <span className="text-slate-500">H</span> <span className={chg !== null && chg < 0 ? 'text-down' : 'text-up'}>{fmt(b.high)}</span>{' '}
                <span className="text-slate-500">L</span> <span className={chg !== null && chg < 0 ? 'text-down' : 'text-up'}>{fmt(b.low)}</span>{' '}
                <span className="text-slate-500">C</span> <span className={chg !== null && chg < 0 ? 'text-down' : 'text-up'}>{fmt(b.close)}</span>{' '}
                {chg !== null && <span className={chg < 0 ? 'text-down' : 'text-up'}>{chg >= 0 ? '+' : ''}{fmt(chg)} ({chgPct! >= 0 ? '+' : ''}{fmt(chgPct)}%)</span>}{' '}
                {on.has('vol') && <><span className="text-slate-500">Vol</span> <span className="text-slate-300">{vol(b.volume)}</span></>}
              </span>
            )}
          </div>
          {legend.map((l) => (
            <div key={l.label} className="tabular-nums">
              <span style={{ color: l.color }}>{l.label}</span> <span className="text-slate-300">{l.text}</span>
            </div>
          ))}
        </div>
        {(!bars || bars.length === 0) && (
          <div className="absolute inset-0 grid place-items-center text-sm text-slate-500">
            {error ? <span className="max-w-md px-4 text-center text-down">{error}</span> : loading ? 'Loading chart…' : 'No data'}
          </div>
        )}
      </div>

      {on.has('rsi') && (
        <div className={`relative mt-1 ${full ? 'h-[16%]' : 'h-28'}`}>
          <div ref={rsiBox} className="absolute inset-0" />
          <span className="pointer-events-none absolute left-2 top-1 z-10 text-[11px] text-slate-400">RSI (14) <span className="tabular-nums text-accent">{fmt(val(calc?.rsi))}</span></span>
        </div>
      )}
      {on.has('macd') && (
        <div className={`relative mt-1 ${full ? 'h-[18%]' : 'h-32'}`}>
          <div ref={macdBox} className="absolute inset-0" />
          <span className="pointer-events-none absolute left-2 top-1 z-10 text-[11px] text-slate-400">
            MACD (12, 26, 9) <span className="tabular-nums text-accent">{fmt(val(calc?.macd?.macd))}</span> <span className="tabular-nums text-amber-400">{fmt(val(calc?.macd?.signal))}</span> <span className="tabular-nums text-slate-300">{fmt(val(calc?.macd?.hist))}</span>
          </span>
        </div>
      )}

      {data?.source?.warning && <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">{data.source.warning}</p>}
      <p className="mt-2 text-xs text-slate-500">
        {data ? `${data.dataNote} Updated ${clock(data.fetchedAt)} IST; refreshes every ${intraday ? '30 seconds' : '5 minutes'}. ${data.session.open ? 'NSE is open.' : 'Market closed: showing the last session.'}` : 'Delayed data from Yahoo Finance; not real-time.'}{' '}
        Scroll to zoom, drag to pan. Research only: no order buttons.
      </p>
    </div>
  );
}
