import { Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import type { Trade } from '../lib/types';
import { useApi } from '../lib/useApi';
import { TradesTable } from './Dashboard';

export function Trades() {
  const { data, error } = useApi<Trade[]>('/api/trades?limit=200');
  return (
    <>
      <PageHeader title="Trade History" description="Every paper fill recorded by the engine, newest first." />
      {error && <ErrorBox message={error} />}
      <Card>{!data ? <Loading /> : data.length === 0 ? <Empty>No paper trades yet.</Empty> : <TradesTable trades={data} />}</Card>
    </>
  );
}
