import { useState } from 'react';
import { JobRunner } from '../components/Controls';
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { istTime, pct, signedPoints, tone } from '../lib/format';
import type { MarketOverview, ProfileInfo, ProfilesView, Watchlist as WL } from '../lib/types';
import { useApi } from '../lib/useApi';

/**
 * Stock-picking styles: the rules famous investors published (Buffett, Graham, Greenblatt, Lynch, ...)
 * turned into screens over the company study's data. The chosen style builds the next watchlist.
 */
function StylePicker() {
  const { data: v, error, reload } = useApi<ProfilesView>('/api/profiles');
  const [open, setOpen] = useState<ProfileInfo['id'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function choose(p: ProfileInfo) {
    if (!window.confirm(`Use "${p.name}" to build the watchlist? Press "Refresh watchlist now" afterwards to apply it.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/control/profile', { method: 'POST', body: { id: p.id } });
      setMsg({ ok: true, text: `${p.name} chosen. Now press "Refresh watchlist now" below to rebuild the watchlist with it.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      void reload();
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (!v) return <Loading />;
  const canChoose = v.canControl && v.tradingMode === 'paper';
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-300">
        Choose whose rules pick the stocks. Each style is the investor's own published rules applied to the study's free data;
        the timing of buys and sells is set in the <b>Strategy Lab</b>.
      </p>
      {msg && <p className={`text-sm ${msg.ok ? 'text-accent' : 'text-down'}`}>{msg.text}</p>}
      {!v.canControl && <p className="text-xs text-slate-500">This account is view-only.</p>}
      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
        {v.profiles.map((p) => {
          const active = v.active.id === p.id;
          const expanded = open === p.id;
          return (
            <section key={p.id} className={`flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-850 p-3 ${active ? 'ring-1 ring-accent/60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">{p.name}</h3>
                  <p className="text-xs text-slate-500">{p.investor}</p>
                </div>
                {active && <Badge color="blue">Active</Badge>}
              </div>
              <p className="text-xs text-slate-300">{p.summary}</p>
              {expanded && (
                <div className="space-y-2 text-xs">
                  <ul className="list-disc space-y-0.5 pl-4 text-slate-300">{p.picks.map((r) => <li key={r}>{r}</li>)}</ul>
                  <p className="text-slate-400"><b>Pairs with:</b> {p.pairsWith} (Strategy Lab)</p>
                  <p className="text-slate-500"><b>Source:</b> {p.source}</p>
                  <p className="text-amber-300/80"><b>Limits:</b> {p.limits}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" className="btn-ghost flex-1 justify-center whitespace-nowrap text-xs" onClick={() => setOpen(expanded ? null : p.id)}>
                  {expanded ? 'Hide rules' : 'Show rules'}
                </button>
                {!active && canChoose && (
                  <button type="button" className="btn-ghost flex-1 justify-center whitespace-nowrap text-xs" disabled={busy} onClick={() => void choose(p)}>
                    Use this style
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">
        {v.active.source === 'website' && v.active.changedAt ? `Chosen by ${v.active.changedBy} on ${istTime(v.active.changedAt)}.` : 'Default style (Balanced score from the settings file).'}{' '}
        A style only filters and ranks companies: it never buys anything itself, and its numbers are not a recommendation.
      </p>
    </div>
  );
}

export function Watchlist() {
  const wl = useApi<WL>('/api/watchlist');
  const market = useApi<MarketOverview>('/api/market/overview', 120_000);
  return (
    <>
      <PageHeader title="Market Watchlist" description="Stocks the company study approved. The engine only buys from this list, and refuses a list older than 7 days, so refresh it at least weekly." />
      <Card title="Stock-picking style" className="mb-4">
        <StylePicker />
      </Card>
      <Card title="Refresh the watchlist" className="mb-4">
        {wl.data?.autoStudy ? (
          <p className="mb-3 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-slate-200">
            🤖 <b>Automatic:</b> AlgoTrade analyses the companies and refreshes this list by itself every trading day from {wl.data.autoStudy.at} IST, in time for the engine's 15:10 check. <span className="text-slate-400">{wl.data.autoStudy.note}{wl.data.autoStudy.lastStartedAt ? ` Last automatic run: ${istTime(wl.data.autoStudy.lastStartedAt)}.` : ''}</span>
          </p>
        ) : null}
        <JobRunner job="study" onDone={wl.reload} />
      </Card>
      {wl.error && <ErrorBox message={wl.error} />}
      {!wl.data ? (
        <Loading />
      ) : wl.data.entries.length === 0 ? (
        <Empty>
          {wl.data.generatedAt
            ? <>No company passed {wl.data.profile ? <b>{wl.data.profile.name}</b> : 'the'} rules this time (strict styles such as Graham often pass very few). See the reasons below, or choose another style.</>
            : <>No watchlist yet. Press <b>Refresh watchlist now</b> above.</>}
        </Empty>
      ) : (
        <div className="space-y-4">
          <Card title={`Watchlist${wl.data.profile ? ` · ${wl.data.profile.name}` : ''} · generated ${istTime(wl.data.generatedAt)}`}>
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
        </div>
      )}
      {wl.data && wl.data.rejected.length > 0 && (
        <Card title="Not selected, and why" className="mt-4">
          <ul className="grid gap-1 text-sm text-slate-400 sm:grid-cols-2">{wl.data.rejected.map((r) => <li key={r.symbol}><span className="text-slate-200">{r.symbol}</span>: {r.reason}</li>)}</ul>
        </Card>
      )}
    </>
  );
}
