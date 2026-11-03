import { EquityChart } from '../components/EquityChart';
import { Card, Empty, ErrorBox, Loading, PageHeader, Stat } from '../components/ui';
import { istTime, signedPct, tone } from '../lib/format';
import type { BacktestSummary } from '../lib/types';
import { useApi } from '../lib/useApi';

export function Backtest() {
  const { data, error } = useApi<BacktestSummary | { none: true; hint: string }>('/api/backtest/latest');
  const b = data && !('none' in data) ? data : null;
  return (
    <>
      <PageHeader title="Backtesting" description="Latest saved portfolio backtest vs the NIFTY 50. Running backtests from the website and full metrics come in Phase 2." />
      {error && <ErrorBox message={error} />}
      {!data ? (
        <Loading />
      ) : !b ? (
        <Empty>
          No backtest saved yet. In the project folder run:
          <pre className="mt-2 text-xs text-slate-300">npm run portfolio -- --json data/backtests/latest.json</pre>
        </Empty>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Strategy return" value={signedPct(b.strategyReturn, 1)} valueClass={tone(b.strategyReturn)} />
            <Stat label="NIFTY 50 return" value={signedPct(b.benchmarkReturn, 1)} valueClass={tone(b.benchmarkReturn)} />
            <Stat label="Period" value={<span className="text-base">{b.period.from} → {b.period.to}</span>} />
            <Stat label="Generated" value={<span className="text-base">{istTime(b.generatedAt)}</span>} />
          </div>
          <Card title="Equity: strategy vs benchmark">
            <EquityChart height={340} series={[
              { label: 'Strategy', color: '#ff2d78', points: b.curve.map((p) => ({ time: p.day, value: p.strategy })) },
              { label: 'NIFTY 50', color: '#94a3b8', points: b.curve.map((p) => ({ time: p.day, value: p.benchmark })) },
            ]} />
            <p className="mt-2 text-xs text-slate-500">{b.benchmarkLabel}. Historical simulation with costs and slippage; survivorship and other biases apply (see the command-line report). Not a forecast.</p>
          </Card>
        </div>
      )}
    </>
  );
}
