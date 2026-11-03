import { useNavigate } from 'react-router';
import type { MarketMovers as Movers, MoverRow } from '../lib/types';
import { ErrorBox } from './ui';

/**
 * Exchange-wall style LED displays: a scrolling ticker tape and a Top Gainers / Top Losers board.
 * Prices are delayed quotes; the board says so and never claims to be real-time.
 */

const price = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chg = (v: number) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}%`;
const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--');

/** Refresh cadence: every minute while NSE is open, every 5 minutes otherwise. */
export const moversRefreshMs = (m: Movers | null) => (m?.session.open ? 60_000 : 300_000);

export function TickerTape({ data }: { data: Movers | null }) {
  const navigate = useNavigate();
  if (!data || data.tape.length === 0) return null;
  const items = data.tape;
  const Item = ({ r }: { r: MoverRow }) => (
    <button type="button" onClick={() => navigate(`/research?q=${encodeURIComponent(r.symbol)}`)} className="led flex shrink-0 items-baseline gap-2 px-5 text-lg" title={`${r.name ?? r.symbol}: open research`}>
      <span className="led-amber">{r.symbol}</span>
      <span className="text-slate-200">{price(r.price)}</span>
      <span className={r.changePct > 0 ? 'led-green' : r.changePct < 0 ? 'led-red' : 'led-dim'}>
        {r.changePct > 0 ? '▲' : r.changePct < 0 ? '▼' : '■'} {chg(r.changePct)}
      </span>
    </button>
  );
  return (
    <div className="led-board ticker-wrap overflow-hidden !py-2" aria-label="Ticker tape of large NSE stocks (delayed)">
      {/* The list is rendered twice so the loop is seamless; the copy is hidden from screen readers. */}
      <div className="ticker-track" style={{ animationDuration: `${Math.max(40, items.length * 4)}s` }}>
        <div className="flex">{items.map((r) => <Item key={r.symbol} r={r} />)}</div>
        <div className="flex" aria-hidden="true">{items.map((r) => <Item key={r.symbol} r={r} />)}</div>
      </div>
    </div>
  );
}

function Panel({ title, rows, kind }: { title: string; rows: MoverRow[]; kind: 'up' | 'down' }) {
  const navigate = useNavigate();
  const color = kind === 'up' ? 'led-green' : 'led-red';
  return (
    <div className="led-board min-w-0">
      <div className={`led mb-2 flex items-center justify-between border-b border-white/10 pb-2 text-xl sm:text-2xl ${color}`}>
        <span>{kind === 'up' ? '▲' : '▼'} {title}</span>
        <span className="led-dim text-xs sm:text-sm">CHG %</span>
      </div>
      {rows.length === 0 ? (
        <p className="led led-dim py-6 text-center text-lg">{kind === 'up' ? 'NO STOCKS UP' : 'NO STOCKS DOWN'}</p>
      ) : (
        rows.map((r, i) => (
          <div
            key={`${r.symbol}-${r.price}`}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/research?q=${encodeURIComponent(r.symbol)}`)}
            onKeyDown={(e) => e.key === 'Enter' && navigate(`/research?q=${encodeURIComponent(r.symbol)}`)}
            className="led-row led-flash led text-base sm:text-lg"
            title={`${r.name ?? r.symbol}: click to open its research`}
          >
            <span className="led-dim">{String(i + 1).padStart(2, '0')}</span>
            <span className="led-amber truncate">{r.symbol}</span>
            <span className="text-right text-slate-200">{price(r.price)}</span>
            <span className={`min-w-[4.8rem] text-right sm:min-w-[5.5rem] ${color}`}>{chg(r.changePct)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function MoversBoard({ data, error }: { data: Movers | null; error: string | null }) {
  if (error && !data) return <ErrorBox message={error} />;
  return (
    <section aria-label="Top gainers and losers">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <h2 className="led led-amber text-lg tracking-widest sm:text-xl">MARKET MOVERS</h2>
        {data && (
          <span className="led flex items-center gap-3 text-sm">
            {data.session.open ? (
              <span className="led-green"><span className="led-blink">●</span> NSE OPEN · DELAYED ~15 MIN</span>
            ) : (
              <span className="led-dim">● MARKET CLOSED · LAST SESSION</span>
            )}
            <span className="led-dim">UPDATED {clock(data.generatedAt)} IST</span>
          </span>
        )}
      </div>
      {!data ? (
        <div className="led-board led led-dim py-10 text-center text-lg">LOADING QUOTES…</div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="TOP GAINERS" rows={data.gainers} kind="up" />
            <Panel title="TOP LOSERS" rows={data.losers} kind="down" />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {data.dataNote} Refreshes every {data.session.open ? 'minute' : '5 minutes'}.{data.unavailable > 0 ? ` ${data.unavailable} symbols had no quote.` : ''} Click a stock to open its research.
            {error ? ` Last refresh failed (${error}); showing the previous figures.` : ''}
          </p>
        </>
      )}
    </section>
  );
}
