import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import { useEffect, useRef } from 'react';

export interface Line {
  label: string;
  color: string;
  points: { time: string; value: number }[];
  width?: 1 | 2 | 3;
}

/** Time-series line chart with optional horizontal levels (TradingView lightweight-charts). */
export function TimeChart({ lines, levels = [], height = 300, format = (v: number) => v.toFixed(2) }: { lines: Line[]; levels?: { price: number; color: string; title: string }[]; height?: number; format?: (v: number) => string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', fontSize: 11 },
      grid: { vertLines: { color: '#18212d' }, horzLines: { color: '#18212d' } },
      rightPriceScale: { borderColor: '#243041' },
      timeScale: { borderColor: '#243041' },
      localization: { priceFormatter: format },
    });
    lines.forEach((l, i) => {
      const s = c.addLineSeries({ color: l.color, lineWidth: l.width ?? 1, title: l.label, lastValueVisible: i === 0, priceLineVisible: false });
      s.setData(l.points);
      if (i === 0) for (const lv of levels) s.createPriceLine({ price: lv.price, color: lv.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: lv.title });
    });
    c.timeScale().fitContent();
    return () => c.remove();
  }, [lines, levels, format]);
  return <div ref={box} style={{ height }} className="w-full" />;
}

/** Small grouped bar chart for a few periods (pure HTML; no chart library needed). */
export function Bars({ periods, series }: { periods: string[]; series: { label: string; color: string; values: (number | null)[] }[] }) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = Math.max(1, ...all.map(Math.abs));
  return (
    <div>
      <div className="flex h-40 items-end gap-3 border-b border-ink-700 px-1">
        {periods.map((p, i) => (
          <div key={p} className="flex h-full flex-1 items-end justify-center gap-1">
            {series.map((s) => {
              const v = s.values[i] ?? null;
              const h = v === null ? 0 : Math.max(2, (Math.abs(v) / max) * 100);
              return <div key={s.label} title={`${s.label} ${p}: ${v === null ? 'Not Available' : `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`}`} className={`w-full max-w-6 rounded-t ${v !== null && v < 0 ? 'opacity-50' : ''}`} style={{ height: `${h}%`, background: s.color }} />;
            })}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-3 px-1 text-[11px] text-slate-500">
        {periods.map((p) => <div key={p} className="flex-1 text-center">{p.slice(0, 7)}</div>)}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-slate-400">
        {series.map((s) => <span key={s.label} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
      </div>
    </div>
  );
}
