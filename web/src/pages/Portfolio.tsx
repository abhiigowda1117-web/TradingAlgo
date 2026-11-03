import { Badge, Card, Empty, ErrorBox, Loading, PageHeader, Stat } from '../components/ui';
import { inr, inrShort, pct, tone } from '../lib/format';
import type { EngineStatus } from '../lib/types';
import { useApi } from '../lib/useApi';

export function Portfolio() {
  const { data: e, error } = useApi<EngineStatus>('/api/engine/status', 60_000);
  return (
    <>
      <PageHeader title="Paper Trading Portfolio" description="Simulated money only. Prices are delayed (Yahoo Finance)." />
      {error && <ErrorBox message={error} />}
      {!e ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Equity" value={e.equity == null ? '—' : inrShort(e.equity)} sub={e.cash == null ? 'No paper account yet: start the engine' : undefined} />
            <Stat label="Cash" value={e.cash == null ? '—' : inrShort(e.cash)} />
            <Stat label="Invested" value={e.investedPct == null ? '—' : pct(e.investedPct)} />
            <Stat label="Today's P&L" value={e.dayPnl == null ? '—' : inr(e.dayPnl)} valueClass={tone(e.dayPnl)} />
          </div>
          {e.priceError && <ErrorBox message={e.priceError} />}
          <Card title="Positions">
            {e.positions.length === 0 ? (
              <Empty>No open positions.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Stock</th><th className="num">Qty</th><th className="num">Avg price</th><th className="num">Last</th><th className="num">Value</th><th className="num">P&L</th><th className="num">Stop</th><th>Protection</th></tr></thead>
                  <tbody>
                    {e.positions.map((p) => (
                      <tr key={p.symbol}>
                        <td><div className="font-medium">{p.symbol}</div><div className="text-xs text-slate-500">since {p.entryDate}</div></td>
                        <td className="num">{p.qty}</td>
                        <td className="num">{inr(p.entryPrice, 2)}</td>
                        <td className="num">{inr(p.last, 2)}</td>
                        <td className="num">{inr(p.value)}</td>
                        <td className={`num ${tone(p.pnl)}`}>{inr(p.pnl)}</td>
                        <td className="num">{inr(p.protectedStop ?? p.stop, 2)}</td>
                        <td>{p.exitReason ? <Badge color="amber">Exiting</Badge> : <Badge color={p.protection === 'confirmed' ? 'green' : 'red'}>{p.protection === 'confirmed' ? 'Stop confirmed' : `Unprotected (${p.protection})`}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
