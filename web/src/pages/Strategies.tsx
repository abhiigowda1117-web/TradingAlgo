import { useState } from 'react';
import { JobRunner } from '../components/Controls';
import { EquityChart } from '../components/EquityChart';
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { istTime, pct, signedPct } from '../lib/format';
import type { PerfSummary, StrategiesView, StrategyInfo, StrategyLab } from '../lib/types';
import { useApi } from '../lib/useApi';

/**
 * Strategy Lab: the strategies in plain words, an honest side-by-side backtest against the NIFTY 50
 * (same stocks, costs and risk rules; textbook settings, not tuned), and the choice of strategy for the
 * PAPER engine's new buys.
 */

const COLORS: Record<StrategyInfo['id'], string> = { emaTrend: '#3db8ff', donchian: '#f59e0b', momentum52: '#a3e635', rsi2: '#e879f9', supertrend: '#fb7185', minervini: '#22d3ee', canslim: '#facc15', weinstein: '#c084fc', buyHold: '#34d399' };
const NIFTY = '#94a3b8';
const TEST = 2; // periods: [full, training, test]

function results(lab: StrategyLab | null, id: StrategyInfo['id']) {
  const s = lab?.strategies.find((x) => x.id === id);
  if (!lab || !s) return null;
  const full = s.periods[0]!;
  const test = s.periods[TEST]!;
  const nTest = lab.benchmark.periods[TEST]!;
  return { full, test, beatTest: test.totalReturn > nTest.totalReturn, nTest };
}

function StrategyCard({ s, v, onChoose, busy }: { s: StrategyInfo; v: StrategiesView; onChoose: (id: StrategyInfo['id']) => void; busy: boolean }) {
  const active = v.active.name === s.id;
  const r = results(v.lab, s.id);
  return (
    <section className={`card flex flex-col gap-3 ${active ? 'ring-1 ring-accent/60' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS[s.id] }} />
            {s.name}
          </h2>
          <p className="text-xs text-slate-500">{s.style}{s.inspiredBy ? ` · ${s.inspiredBy}` : ''}</p>
        </div>
        {active && <Badge color="blue">Active (paper)</Badge>}
      </div>
      <p className="text-sm text-slate-300">{s.summary}</p>
      <dl className="space-y-1.5 text-xs">
        <div><dt className="inline font-semibold text-up">Buy: </dt><dd className="inline text-slate-300">{s.buy}</dd></div>
        <div><dt className="inline font-semibold text-down">Sell: </dt><dd className="inline text-slate-300">{s.sell}</dd></div>
        <div><dt className="inline font-semibold text-slate-400">Works best: </dt><dd className="inline text-slate-400">{s.suits}</dd></div>
        {s.source && <div><dt className="inline font-semibold text-slate-500">Source: </dt><dd className="inline text-slate-500">{s.source}</dd></div>}
      </dl>
      {r && (
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-ink-850 p-2 text-center text-xs">
          <div><div className="text-slate-500">CAGR</div><div className="font-semibold tabular-nums">{pct(r.full.cagr)}</div></div>
          <div><div className="text-slate-500">Worst fall</div><div className="font-semibold tabular-nums text-down">{pct(-r.full.maxDrawdown)}</div></div>
          <div><div className="text-slate-500">Test period</div><div className={`font-semibold tabular-nums ${r.beatTest ? 'text-up' : 'text-down'}`}>{signedPct(r.test.totalReturn, 1)}</div></div>
          <div className="col-span-3">
            {r.beatTest ? <Badge color="green">Beat the NIFTY 50 in the unseen test period</Badge> : <Badge color="red">Lagged the NIFTY 50 in the unseen test period ({signedPct(r.nTest.totalReturn, 1)})</Badge>}
          </div>
        </div>
      )}
      <div className="mt-auto">
        {active ? (
          <p className="text-xs text-slate-500">The paper engine uses this strategy for new buys.</p>
        ) : v.canControl && v.tradingMode === 'paper' ? (
          <button type="button" className="btn-ghost w-full justify-center" disabled={busy} onClick={() => onChoose(s.id)}>
            Use for paper trading
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ResultsTable({ lab, active }: { lab: StrategyLab; active: StrategyInfo['id'] }) {
  const rows: { key: string; name: string; color: string; full: PerfSummary; test: PerfSummary }[] = [
    ...lab.strategies.map((s) => ({ key: s.id, name: s.name, color: COLORS[s.id], full: s.periods[0]!, test: s.periods[TEST]! })),
    { key: 'nifty', name: 'NIFTY 50 (buy and hold)', color: NIFTY, full: lab.benchmark.periods[0]!, test: lab.benchmark.periods[TEST]! },
  ];
  const nTest = lab.benchmark.periods[TEST]!.totalReturn;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Strategy</th>
            <th className="num">Total return</th>
            <th className="num">CAGR</th>
            <th className="num">Worst fall</th>
            <th className="num">Sharpe</th>
            <th className="num">Trades</th>
            <th className="num">Win rate</th>
            <th className="num">Test period</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.key === 'nifty' ? 'italic text-slate-400' : r.key === active ? 'bg-accent/5' : ''}>
              <td className="whitespace-nowrap">
                <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />
                {r.name}
                {r.key === active && <span className="ml-2 text-[10px] text-accent">ACTIVE</span>}
              </td>
              <td className="num">{signedPct(r.full.totalReturn, 1)}</td>
              <td className="num">{pct(r.full.cagr)}</td>
              <td className="num text-down">{pct(-r.full.maxDrawdown)}</td>
              <td className="num">{Number.isFinite(r.full.sharpe) ? r.full.sharpe.toFixed(2) : '—'}</td>
              <td className="num">{r.key === 'nifty' ? '1 buy' : r.full.trades ?? 0}</td>
              <td className="num">{r.full.winRate === undefined ? '—' : pct(r.full.winRate)}</td>
              <td className={`num font-semibold ${r.key === 'nifty' ? '' : r.test.totalReturn > nTest ? 'text-up' : 'text-down'}`}>{signedPct(r.test.totalReturn, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Strategies() {
  const { data: v, error, reload } = useApi<StrategiesView>('/api/strategies');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function choose(id: StrategyInfo['id']) {
    const name = v?.strategies.find((s) => s.id === id)?.name ?? id;
    if (!window.confirm(`Use "${name}" for the paper engine's new buys? Positions you already hold keep their own strategy's sell rules.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/control/strategy', { method: 'POST', body: { name: id } });
      setMsg({ ok: true, text: `${name} is now active. It applies from the engine's next daily check (15:10 IST).` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      void reload();
    }
  }

  const lab = v?.lab ?? null;
  return (
    <>
      <PageHeader
        title="Strategy Lab"
        description="Well-known trading strategies from famous traders, compared honestly on the same stocks, costs and risk rules against simply holding the NIFTY 50. Pick which one the paper engine uses."
      />
      {error && <ErrorBox message={error} />}
      {!v ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          <Card title="Active strategy (paper engine)">
            <p className="text-sm">
              <b>{v.strategies.find((s) => s.id === v.active.name)?.name}</b>{' '}
              <span className="text-slate-400">
                {v.active.source === 'website' && v.active.changedAt ? `chosen by ${v.active.changedBy} on ${istTime(v.active.changedAt)}` : '(default from the settings file)'}
              </span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              It decides the engine's new buys at the daily 15:10 IST check. Every position remembers the strategy that bought it and is sold by that strategy's rules, even after you switch. Risk limits, position sizes, stop-losses and the kill switch are the same for every strategy.
            </p>
            {v.tradingMode !== 'paper' && <p className="mt-2 text-sm text-amber-300">TRADING_MODE is not paper: the strategy can only be changed from the website in paper trading.</p>}
            {!v.canControl && <p className="mt-2 text-xs text-slate-500">This account is view-only.</p>}
            {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-accent' : 'text-down'}`}>{msg.text}</p>}
          </Card>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {v.strategies.map((s) => (
              <StrategyCard key={s.id} s={s} v={v} onChoose={(id) => void choose(id)} busy={busy} />
            ))}
          </div>

          <Card title="Compare all strategies">
            <JobRunner job="lab" onDone={reload} />
          </Card>

          <Card title={lab ? `Results: ${lab.period.from} to ${lab.period.to}` : 'Results'}>
            {!lab ? (
              <Empty>No comparison yet. Press <b>Compare all strategies</b> above (it takes a few minutes).</Empty>
            ) : (
              <div className="space-y-4">
                <EquityChart
                  height={300}
                  series={[
                    ...lab.strategies.map((s) => ({ label: s.name, color: COLORS[s.id], points: lab.days.map((d, i) => ({ time: d, value: s.curve[i]! })) })),
                    { label: 'NIFTY 50', color: NIFTY, points: lab.days.map((d, i) => ({ time: d, value: lab.benchmarkCurve[i]! })) },
                  ]}
                />
                <ResultsTable lab={lab} active={v.active.name} />
                <ul className="list-disc space-y-1 pl-5 text-xs text-slate-400">
                  <li>
                    Each strategy started with ₹{lab.settings.capital.toLocaleString('en-IN')}, at most {lab.settings.maxOpenPositions} positions and {(lab.settings.riskPerTrade * 100).toFixed(1)}% risk per trade, with Indian trading costs and slippage. {lab.universe.count} stocks; {lab.benchmark.label}.
                  </li>
                  <li>
                    <b>Test period</b> ({lab.period.split} onwards) is the honest check: the rules were not adjusted on it. A strategy that only looks good over the full period but lags the NIFTY 50 in the test period has no proven edge.
                  </li>
                  <li>All strategies use standard textbook settings; none were tuned to these results.</li>
                  {lab.survivorshipBias && <li>The stock list is today's large caps, which flatters every strategy (survivorship bias).</li>}
                  <li>Past results do not predict future returns. Compared on {istTime(lab.generatedAt)}.</li>
                </ul>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
