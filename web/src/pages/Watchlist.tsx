import { JobRunner } from '../components/Controls';
import { Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { istTime, pct, signedPoints, tone } from '../lib/format';
import type { MarketOverview, Watchlist as WL } from '../lib/types';
import { useApi } from '../lib/useApi';

export function Watchlist() {
  const wl = useApi<WL>('/api/watchlist');
  const market = useApi<MarketOverview>('/api/market/overview', 120_000);
  return (
    <>
      <PageHeader title="Market Watchlist" description="Stocks the company study approved. The engine only buys from this list, and refuses a list older than 7 days, so refresh it at least weekly." />
      <Card title="Refresh the watchlist" className="mb-4">
        <JobRunner job="study" onDone={wl.reload} />
      </Card>
      {wl.error && <ErrorBox message={wl.error} />}
      {!wl.data ? (
        <Loading />
      ) : wl.data.entries.length === 0 ? (
        <Empty>No watchlist yet. Press <b>Refresh watchlist now</b> above.</Empty>
      ) : (
        <div className="space-y-4">
          <Card title={`Watchlist · generated ${istTime(wl.data.generatedAt)}`}>
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Stock</th><th>Sector</th><th className="num">Combined</th><th className="num">Fundamentals</th><th className="num">News tone</th><th className="num">Today</th><th className="num">52-wk position</th></tr></thead>
                <tbody>
                  {wl.data.entries.map((w) => {
                    const q = market.data?.stocks.find((s) => s.symbol === w.symbol);
                    return (
                      <tr key={w.symbol}>
                        <td><div className="font-medium">{w.symbol}</div><div className="text-xs text-slate-500">{w.name}</div></td>
                        <td className="text-slate-400">{w.sector ?? '—'}</td>
                        <td className="num">{w.combinedScore.toFixed(1)}</td>
                        <td className="num">{w.fundamentalScore.toFixed(1)}</td>
                        <td className={`num ${tone(w.sentiment)}`}>{w.sentiment.toFixed(2)}</td>
                        <td className={`num ${tone(q?.changePct)}`}>{q ? signedPoints(q.changePct) : '—'}</td>
                        <td className="num">{q ? pct(q.range52, 0) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-500">Scores: automated, rule-based (interpretation). Prices delayed.</p>
          </Card>
          {wl.data.rejected.length > 0 && (
            <Card title="Not selected, and why">
              <ul className="grid gap-1 text-sm text-slate-400 sm:grid-cols-2">{wl.data.rejected.map((r) => <li key={r.symbol}><span className="text-slate-200">{r.symbol}</span>: {r.reason}</li>)}</ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
