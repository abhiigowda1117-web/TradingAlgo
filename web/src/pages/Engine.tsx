import { Badge, Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { ago, inr, istTime } from '../lib/format';
import type { EngineStatus } from '../lib/types';
import { useApi } from '../lib/useApi';

export function EngineBadge({ e }: { e: EngineStatus }) {
  if (!e.heartbeat) return <Badge color="gray">Never started</Badge>;
  if (!e.heartbeat.alive) return <Badge color="red">Not running</Badge>;
  if (e.heartbeat.result === 'error') return <Badge color="amber">Running with errors</Badge>;
  if (e.heartbeat.result === 'closed') return <Badge color="blue">Running · market closed</Badge>;
  if (e.heartbeat.result === 'halted') return <Badge color="amber">Running · halted</Badge>;
  return <Badge color="green">Running</Badge>;
}

export function Engine() {
  const { data: e, error } = useApi<EngineStatus>('/api/engine/status', 30_000);
  return (
    <>
      <PageHeader title="Trading Engine" description="Status of the paper-trading engine, read from its files. The website never places orders; the engine runs as its own process." />
      {error && <ErrorBox message={error} />}
      {!e ? (
        <Loading />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Status">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-400">Engine</dt><dd><EngineBadge e={e} /></dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Last heartbeat</dt><dd>{e.heartbeat ? `${istTime(e.heartbeat.at)} (${ago(e.heartbeat.ageSeconds)})` : 'Never'}</dd></div>
              {e.heartbeat?.error && <div className="text-down">Last error: {e.heartbeat.error}</div>}
              <div className="flex justify-between"><dt className="text-slate-400">Broker</dt><dd>{e.heartbeat?.broker ?? '—'} ({e.mode})</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Kill switch</dt><dd><Badge color={e.killSwitch === 'off' ? 'green' : 'red'}>{e.killSwitch.toUpperCase()}</Badge></dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Day-start equity</dt><dd>{inr(e.dayStartEquity)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Last daily evaluation</dt><dd>{e.lastEvaluated ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Entries halted (daily loss)</dt><dd>{e.haltedOn ?? 'No'}</dd></div>
            </dl>
            {e.errors.map((x) => <ErrorBox key={x} message={x} />)}
          </Card>
          <Card title="Control (Phase 2)">
            <p className="text-sm text-slate-400">Buttons for the kill switch and engine jobs come in Phase 2. For now, from a Command Prompt in the project folder:</p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-ink-950 p-3 text-xs text-slate-300">{`npm run trade                 start the paper engine
npm run trade -- --status     positions and protection
type nul > STOP               kill switch: no new entries
echo FLATTEN> STOP            kill switch: sell all, stop
del STOP                      resume`}</pre>
          </Card>
          <Card title="Orders in progress" className="lg:col-span-2">
            {e.openOrders.length === 0 ? (
              <Empty>No unfinished orders.</Empty>
            ) : (
              <table className="table">
                <thead><tr><th>Order</th><th>Type</th><th>Stock</th><th className="num">Qty</th><th>Status</th></tr></thead>
                <tbody>{e.openOrders.map((o) => <tr key={o.id}><td className="font-mono text-xs">{o.id}</td><td>{o.kind} {o.side}</td><td>{o.symbol}</td><td className="num">{o.qty}</td><td>{o.status}{o.brokerStatus ? ` (${o.brokerStatus})` : ''}</td></tr>)}</tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
