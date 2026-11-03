import { useEffect, useState } from 'react';
import type { MarketMovers, MarketOverview } from '../lib/types';

/**
 * Compact sidebar panel: IST clock, NSE session with a closing countdown, key indices, breadth among
 * large caps and today's strongest/weakest sector. Delayed data, labelled as such.
 */

function istNow(d: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).map((p) => [p.type, p.value]));
  return { hh: Number(parts.hour) % 24, mm: Number(parts.minute), ss: Number(parts.second), text: `${parts.hour}:${parts.minute}:${parts.second}` };
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const PICKS: [string, string][] = [['^NSEI', 'NIFTY 50'], ['^BSESN', 'SENSEX'], ['^NSEBANK', 'BANK NIFTY'], ['^INDIAVIX', 'INDIA VIX']];
const fmt = (v: number | null) => (v === null ? 'N/A' : v.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
const chg = (v: number | null) => (v === null ? '' : `${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(2)}%`);
const toneOf = (v: number | null) => (v === null || v === 0 ? 'text-slate-400' : v > 0 ? 'text-up' : 'text-down');

export function MarketPulse({ market, movers }: { market: MarketOverview | null; movers: MarketMovers | null }) {
  const now = useClock();
  const t = istNow(now);
  const open = market?.session.open ?? movers?.session.open ?? false;
  const minsToClose = 15 * 60 + 30 - (t.hh * 60 + t.mm);
  const sessionText = open
    ? minsToClose > 0 ? `Closes in ${Math.floor(minsToClose / 60)}h ${String(minsToClose % 60).padStart(2, '0')}m` : 'Closing'
    : (market?.session.label ?? movers?.session.label ?? '').replace(/\s*\(.*\)$/, '');

  const up = movers?.tape.filter((r) => r.changePct > 0.05).length ?? 0;
  const down = movers?.tape.filter((r) => r.changePct < -0.05).length ?? 0;
  const flat = (movers?.tape.length ?? 0) - up - down;
  const total = Math.max(1, up + down + flat);
  const sectors = (market?.indices ?? []).filter((i) => i.group === 'Sector' && i.changePct !== null).sort((a, b) => b.changePct! - a.changePct!);
  const best = sectors[0];
  const worst = sectors.length > 1 ? sectors[sectors.length - 1] : undefined;

  return (
    <div className="mx-1 mt-4 rounded-xl border border-ink-700/80 bg-black/60 p-3 text-xs shadow-[inset_0_0_20px_rgba(47,125,255,0.06)]">
      <div className="flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wider text-rose-soft">Market pulse</span>
        <span className={`led text-[11px] ${open ? 'led-up' : 'led-down'}`}>{open ? <><span className="led-blink">●</span> OPEN</> : '● CLOSED'}</span>
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="led led-sym text-xl">{t.text}</span>
        <span className="text-[10px] text-slate-500">IST</span>
      </div>
      {sessionText && <div className="text-[11px] text-slate-400">{sessionText}</div>}

      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {PICKS.map(([ticker, label]) => {
          const i = market?.indices.find((x) => x.ticker === ticker);
          return (
            <div key={ticker} className="rounded-md border border-ink-700/60 bg-ink-900/80 px-2 py-1.5">
              <div className="truncate text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
              <div className="tabular-nums text-slate-100">{i ? fmt(i.price) : '…'}</div>
              <div className={`tabular-nums text-[11px] ${toneOf(i?.changePct ?? null)}`}>{i ? chg(i.changePct) : ''}</div>
            </div>
          );
        })}
      </div>

      {movers && movers.tape.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[11px]">
            <span className="text-up">{up} up</span>
            <span className="text-slate-500">breadth</span>
            <span className="text-down">{down} down</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-ink-700" role="img" aria-label={`${up} large caps up, ${down} down, ${flat} flat`}>
            <div className="bg-up shadow-[0_0_8px_#3db8ff]" style={{ width: `${(up / total) * 100}%` }} />
            <div className="bg-slate-600" style={{ width: `${(flat / total) * 100}%` }} />
            <div className="bg-down shadow-[0_0_8px_#ff2d78]" style={{ width: `${(down / total) * 100}%` }} />
          </div>
        </div>
      )}

      {best && (
        <div className="mt-3 space-y-0.5 text-[11px]">
          <div className="flex justify-between"><span className="text-slate-500">Strongest</span><span><span className="text-slate-300">{best.label.replace('NIFTY ', '')}</span> <span className={toneOf(best.changePct)}>{chg(best.changePct)}</span></span></div>
          {worst && <div className="flex justify-between"><span className="text-slate-500">Weakest</span><span><span className="text-slate-300">{worst.label.replace('NIFTY ', '')}</span> <span className={toneOf(worst.changePct)}>{chg(worst.changePct)}</span></span></div>}
        </div>
      )}
      <p className="mt-3 text-[10px] leading-snug text-slate-600">Delayed ~15 min. Paper trading only. Not investment advice.</p>
    </div>
  );
}
