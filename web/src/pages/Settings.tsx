import { Badge, Card, ErrorBox, Loading, PageHeader } from '../components/ui';
import { inr } from '../lib/format';
import type { Settings as S } from '../lib/types';
import { useApi } from '../lib/useApi';

function KV({ data }: { data: Record<string, string | number> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="flex justify-between border-b border-ink-800 py-1"><dt className="text-slate-400">{k}</dt><dd className="tabular-nums">{String(v)}</dd></div>
      ))}
    </dl>
  );
}

export function Settings() {
  const { data, error } = useApi<S>('/api/settings');
  return (
    <>
      <PageHeader title="Settings" description="Read-only in Phase 1. Change values in config/trading.json and .env on the server. Secrets are never sent to the browser." />
      {error && <ErrorBox message={error} />}
      {!data ? <Loading /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Account and data">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-400">Trading mode</dt><dd><Badge color={data.tradingMode === 'paper' ? 'blue' : 'red'}>{data.tradingMode.toUpperCase()}</Badge></dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Market data</dt><dd>{data.marketData}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Broker credentials on server</dt><dd>{data.brokerConfigured ? 'Configured (hidden)' : 'Not configured'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Backtest capital</dt><dd>{inr(data.capital)}</dd></div>
            </dl>
          </Card>
          <Card title="Engine"><KV data={data.engine} /></Card>
          <Card title="Strategy"><KV data={data.strategy} /></Card>
          <Card title="Risk limits"><KV data={data.risk} /></Card>
        </div>
      )}
    </>
  );
}
