import { inr, istTime, pct, tone } from '../lib/format';
import type { IntradayView } from '../lib/types';
import { useApi } from '../lib/useApi';
import { Badge, Card, Empty, ErrorBox, Loading } from './ui';

/** The intraday strategies from the owner's document (Strategy Lab page). */
export function IntradayStrategies() {
  const { data: v, error } = useApi<IntradayView>('/api/intraday', 60_000);
  if (error) return <ErrorBox message={error} />;
  if (!v) return <Loading />;
  return (
    <Card title="Intraday strategies (from your document)">
      <p className="mb-3 text-sm text-slate-300">
        Run automatically during market hours by the paper engine, buying <b>and selling short</b>. Each trade risks at most {pct(v.settings.riskPerTrade, 0)} of the
        account, has a stop-loss and a 1:2 target, and is closed by {v.settings.squareOff} IST. All intraday trades together use at most {pct(v.settings.allocationPct, 0)} of the
        money, at most {v.settings.maxTradesPerDay} trades a day, no new trades after {v.settings.lastEntry}.
        {!v.enabled && <span className="text-amber-300"> The intraday desk is switched off.</span>}
      </p>
      <div className="grid gap-3 lg:grid-cols-3">
        {v.strategies.map((s) => (
          <section key={s.id} className="flex flex-col gap-2 rounded-lg border border-ink-700 bg-ink-850 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{s.name}</h3>
                <p className="text-xs text-slate-500">{s.timeframe} candles · intraday</p>
              </div>
              <Badge color={s.on ? 'green' : 'gray'}>{s.on ? 'On' : 'Off'}</Badge>
            </div>
            <p className="text-xs text-slate-300">{s.summary}</p>
            <p className="text-xs"><b className="text-up">Buy: </b><span className="text-slate-300">{s.buy}</span></p>
            <p className="text-xs"><b className="text-down">Sell short: </b><span className="text-slate-300">{s.sell}</span></p>
          </section>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Prices are Yahoo Finance's, delayed by about 15 minutes, so intraday paper results are only indicative; real-time intraday trading would need Zerodha Kite data.
        The Strategy Lab comparison below covers the daily strategy only (free 5-minute history goes back about 60 days).
      </p>
    </Card>
  );
}

/** Today's intraday trades (Paper Portfolio page). */
export function IntradayTrades() {
  const { data: v, error } = useApi<IntradayView>('/api/intraday', 15_000);
  if (error) return <ErrorBox message={error} />;
  if (!v) return <Loading />;
  const sideBadge = (side: string) => (side === 'long' || side === 'BUY' || side === 'SELL' ? <Badge color="green">Long</Badge> : <Badge color="red">Short</Badge>);
  return (
    <Card title={`Intraday trades today (${v.tradesToday} of at most ${v.settings.maxTradesPerDay})`}>
      {v.positions.length === 0 ? (
        <Empty>No intraday trade open. The engine looks for setups every 5 minutes from 9:30 to {v.settings.lastEntry} IST and closes everything by {v.settings.squareOff}.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Stock</th><th>Side</th><th>Strategy</th><th className="num">Qty</th><th className="num">Entry</th><th className="num">Last</th><th className="num">P&L</th><th className="num">Stop</th><th className="num">Target</th></tr></thead>
            <tbody>
              {v.positions.map((p) => (
                <tr key={p.id}>
                  <td><div className="font-medium">{p.symbol}</div><div className="text-xs text-slate-500">{istTime(p.openedAt)}</div></td>
                  <td>{sideBadge(p.side)}</td>
                  <td className="text-xs text-slate-400">{v.strategies.find((s) => s.id === p.strategy)?.name ?? p.strategy}</td>
                  <td className="num">{p.qty}</td>
                  <td className="num">{inr(p.entry, 2)}</td>
                  <td className="num">{p.last === null ? '—' : inr(p.last, 2)}</td>
                  <td className={`num ${tone(p.pnl)}`}>{p.pnl === null ? '—' : inr(p.pnl)}</td>
                  <td className="num">{inr(p.stop, 2)}</td>
                  <td className="num">{inr(p.target, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {v.closedToday.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-sm">
            Closed today: <b className={tone(v.realizedToday)}>{inr(v.realizedToday)}</b> <span className="text-xs text-slate-500">after charges, already added to the paper cash</span>
          </p>
          <ul className="space-y-0.5 text-xs text-slate-400">
            {v.closedToday.map((t) => (
              <li key={`${t.time}${t.symbol}`}>
                {istTime(t.time)} · <span className="text-slate-200">{t.symbol}</span> {t.side === 'COVER' ? 'short covered' : 'sold'} {t.qty} @ {inr(t.price, 2)} · <span className={tone(t.pnl)}>{inr(t.pnl)}</span> · {t.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
