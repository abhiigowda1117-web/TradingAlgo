import { createChart, ColorType, type IChartApi } from 'lightweight-charts';
import { useEffect, useRef } from 'react';

export interface Series {
  label: string;
  color: string;
  points: { time: string; value: number }[];
}

/** Line chart (TradingView lightweight-charts) for equity curves. */
export function EquityChart({ series, height = 260 }: { series: Series[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8b95b3', fontSize: 11 },
      grid: { vertLines: { color: '#18212d' }, horzLines: { color: '#18212d' } },
      rightPriceScale: { borderColor: '#243041' },
      timeScale: { borderColor: '#243041' },
      crosshair: { horzLine: { color: '#475569' }, vertLine: { color: '#475569' } },
      localization: { priceFormatter: (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}` },
    });
    for (const s of series) {
      const line = c.addLineSeries({ color: s.color, lineWidth: 2, title: s.label, priceFormat: { type: 'price', precision: 0, minMove: 1 } });
      line.setData(s.points);
    }
    c.timeScale().fitContent();
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, [series]);

  return <div ref={box} style={{ height }} className="w-full" />;
}
