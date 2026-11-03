import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { BullBearArena } from '../components/BullBearFight';
import { EquityChart } from '../components/EquityChart';
import { MoversBoard, moversRefreshMs, TickerTape } from '../components/MarketMovers';
import { Badge, Card, Empty, ErrorBox, Loading, Stat } from '../components/ui';
import { ago, inr, inrShort, istTime, num, pct, signedPct, signedPoints, tone } from '../lib/format';
import type { DashboardSummary, MarketMovers, MarketOverview, Watchlist } from '../lib/types';
import { useApi } from '../lib/useApi';
import { EngineBadge } from './Engine';

export function Dashboard() {
  const summary = useApi<DashboardSummary>('/api/dashboard/summary', 60_000);
  const market = useApi<MarketOverview>('/api/market/overview', 120_000);
  const watchlist = useApi<Watchlist>('/api/watchlist');
  const [moversMs, setMoversMs] = useState(60_000);
  const movers = useApi<MarketMovers>('/api/market/movers', moversMs);
  useEffect(() => {
    if (movers.data) setMoversMs(moversRefreshMs(movers.data));
  }, [movers.data]);
  const e = summary.data?.engine;

  return (
    <div className="space-y-4">
      <BullBearArena />
      <TickerTape data={movers.data} />
      {summary.error && <ErrorBox message={summary.error} />}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Paper equity"
          value={e?.equity == null ? '—' : inrShort(e.equity)}
          sub={e && !e.paperAccountStarted ? 'Starting capital; no paper trades yet' : e?.priceError ? 'Prices unavailable right now' : 'Cash + positions at delayed prices'}
        />
        <Stat label="Cash" value={e?.cash == null ? '—' : inrShort(e.cash)} sub={e?.investedPct != null ? `${pct(e.investedPct)} invested` : undefined} />
        <Stat label="Today's P&L" value={e?.dayPnl == null ? '—' : inr(e.dayPnl)} valueClass={tone(e?.dayPnl)} sub="vs. equity at the day's start" />
        <Stat label="Open positions" value={e ? String(e.positions.length) : '—'} sub={e ? `${e.openOrders.length} orders in progress` : undefined} />
      </div>

      <MoversBoard data={movers.data} error={movers.error} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Trading engine" action={<Link to="/engine" className="text-xs text-accent">Details</Link>}>
          {!e ? (
            <Loading />
          ) : (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-400">Status</dt><dd><EngineBadge e={e} /></dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Last activity</dt><dd>{e.heartbeat ? ago(e.heartbeat.ageSeconds) : 'Never'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Kill switch</dt><dd><Badge color={e.killSwitch === 'off' ? 'green' : 'red'}>{e.killSwitch.toUpperCase()}</Badge></dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Last daily evaluation</dt><dd>{e.lastEvaluated ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Entries halted</dt><dd>{e.haltedOn ? `Yes (${e.haltedOn})` : 'No'}</dd></div>
            </dl>
          )}
        </Card>

        <Card title="Market overview" className="lg:col-span-2" action={market.data && <span className="text-xs normal-case text-slate-500">{market.data.session.label}</span>}>
          {market.error ? (
            <ErrorBox message={market.error} />
          ) : !market.data ? (
            <Loading label="Fetching delayed market data…" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {market.data.indices.filter((i) => i.group !== 'Sector').concat(market.data.indices.filter((i) => i.group === 'Sector').slice(0, 1)).map((i) => (
                  <div key={i.ticker} className="rounded-lg bg-ink-850 p-3">
                    <div className="text-xs text-slate-500">{i.label}</div>
                    <div className="text-base font-semibold tabular-nums">{num(i.price)}</div>
                    <div className={`text-xs tabular-nums ${tone(i.changePct)}`}>{signedPoints(i.changePct)}</div>
                  </div>
                ))}
              </div>
              <ul className="mt-3 space-y-1 text-sm text-slate-300">
                {market.data.summary.map((s) => <li key={s}>• {s}</li>)}
              </ul>
              {market.data.source?.warning && <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">{market.data.source.warning}</p>}
              <p className="mt-2 text-xs text-slate-500">{market.data.dataNote} Summary is a rule-based interpretation.</p>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Performance" className="lg:col-span-2" action={<Link to="/backtest" className="text-xs text-accent">Backtesting</Link>}>
          {!summary.data ? (
            <Loading />
          ) : summary.data.backtest && summary.data.backtest.curve.length ? (
            <>
              <EquityChart
                series={[
                  { label: 'Strategy', color: '#3db8ff', points: summary.data.backtest.curve.map((p) => ({ time: p.day, value: p.strategy })) },
                  { label: 'NIFTY 50', color: '#94a3b8', points: summary.data.backtest.curve.map((p) => ({ time: p.day, value: p.benchmark })) },
                ]}
              />
              <p className="mt-2 text-xs text-slate-500">
                Latest <b>backtest</b> ({summary.data.backtest.period.from} to {summary.data.backtest.period.to}): strategy {signedPct(summary.data.backtest.strategyReturn, 1)} vs {summary.data.backtest.benchmarkLabel} {signedPct(summary.data.backtest.benchmarkReturn, 1)}. Historical simulation, not live results.
              </p>
            </>
          ) : (
            <Empty>
              No backtest saved yet. Run <code className="text-slate-300">npm run portfolio -- --json data/backtests/latest.json</code> to see the strategy vs NIFTY 50 chart here.
            </Empty>
          )}
        </Card>

        <Card title="Watchlist" action={<Link to="/watchlist" className="text-xs text-accent">All</Link>}>
          {watchlist.error ? (
            <ErrorBox message={watchlist.error} />
          ) : !watchlist.data ? (
            <Loading />
          ) : watchlist.data.entries.length === 0 ? (
            <Empty>No watchlist yet. Run <code className="text-slate-300">npm run study</code>.</Empty>
          ) : (
            <table className="table">
              <thead><tr><th>Stock</th><th className="num">Score</th><th className="num">Today</th></tr></thead>
              <tbody>
                {watchlist.data.entries.slice(0, 8).map((w) => {
                  const q = market.data?.stocks.find((s) => s.symbol === w.symbol);
                  return (
                    <tr key={w.symbol}>
                      <td><div className="font-medium text-slate-200">{w.symbol}</div><div className="max-w-[10rem] truncate text-xs text-slate-500">{w.name}</div></td>
                      <td className="num">{w.combinedScore.toFixed(1)}</td>
                      <td className={`num ${tone(q?.changePct)}`}>{q ? signedPoints(q.changePct) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Recent trade activity" action={<Link to="/trades" className="text-xs text-accent">History</Link>}>
        {!summary.data ? <Loading /> : summary.data.trades.length === 0 ? <Empty>No paper trades yet.</Empty> : <TradesTable trades={summary.data.trades} />}
      </Card>
    </div>
  );
}

export function TradesTable({ trades }: { trades: DashboardSummary['trades'] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Time</th><th>Stock</th><th>Side</th><th className="num">Qty</th><th className="num">Price</th><th className="num">P&L</th><th>Reason</th></tr></thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={`${t.time}-${i}`}>
              <td className="whitespace-nowrap text-slate-400">{istTime(t.time)}</td>
              <td className="font-medium">{t.symbol}</td>
              <td><Badge color={t.side === 'BUY' ? 'blue' : 'amber'}>{t.side}</Badge></td>
              <td className="num">{t.qty ?? '—'}</td>
              <td className="num">{t.price == null ? 'Not Available' : inr(t.price, 2)}</td>
              <td className={`num ${tone(t.pnl)}`}>{t.pnl == null ? '—' : inr(t.pnl)}</td>
              <td className="text-slate-400">{t.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
