import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { istTime } from '../lib/format';
import type { ControlView, JobView, ManualOrderView } from '../lib/types';
import { useApi } from '../lib/useApi';
import { Badge, Empty, ErrorBox } from './ui';

/**
 * Website control panels for the PAPER engine: start/stop, kill switch, buy/sell, background jobs.
 * Every button calls a protected POST action; the server checks the account, the CSRF token, the
 * market hours and the trading mode, and the engine applies all risk rules to orders.
 */

export function useControl(refreshMs = 5000) {
  return useApi<ControlView>('/api/control', refreshMs);
}

/** Runs one action at a time and shows its error; refreshes the control view afterwards. */
function useAction(reload: () => unknown) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run<T>(key: string, path: string, body: unknown, ok?: (r: T) => string | null) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const r = await api<T>(path, { method: 'POST', body });
      setNotice(ok?.(r) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      void reload();
    }
  }
  return { busy, error, notice, run };
}

const ViewOnly = () => <p className="text-xs text-slate-500">This account is view-only. Only the owner can use these buttons.</p>;

function engineLine(c: ControlView) {
  const e = c.engine;
  if (!e) return { badge: <Badge color="gray">Unavailable</Badge>, text: 'Controls are not available on this server.' };
  if (e.running && e.stopRequested) return { badge: <Badge color="amber">Stopping…</Badge>, text: 'It finishes its current check, then stops (usually within a few seconds).' };
  if (e.running)
    return {
      badge: <Badge color="green">Running</Badge>,
      text: `Started ${e.startedAt ? istTime(e.startedAt) : ''} ${e.startedBy === 'terminal' ? 'from a terminal window' : `from the ${e.startedBy ?? 'website'}`}. ${c.market.open ? 'Market open: it is watching positions and checks for new buys at 15:10 IST.' : 'Market closed: it waits for the next session.'}`,
    };
  return { badge: <Badge color="red">Stopped</Badge>, text: 'Press Start to run the paper engine. It manages stop-losses and looks for buys at 15:10 IST each trading day.' };
}

/** Start/stop and the kill switch (Trading Engine page; compact form on the dashboard). */
export function EngineControls({ compact = false }: { compact?: boolean }) {
  const { data: c, error, reload } = useControl(compact ? 10_000 : 4000);
  const a = useAction(reload);
  if (error) return <ErrorBox message={error} />;
  if (!c) return <p className="text-sm text-slate-500">Loading controls…</p>;
  const line = engineLine(c);
  const running = Boolean(c.engine?.running);
  const live = c.tradingMode !== 'paper';
  const start = () => a.run('start', '/api/control/engine/start', {}, () => 'Starting the paper engine…');
  const stop = () => {
    if (window.confirm('Stop the engine? Open positions stay open; their stop-losses are managed again when you start it.')) void a.run('stop', '/api/control/engine/stop', {}, () => 'Stop requested.');
  };
  const ks = (mode: 'off' | 'halt' | 'flatten') => {
    if (mode === 'flatten' && !window.confirm('Sell EVERY paper position at market and then stop the engine?')) return;
    void a.run(mode, '/api/control/kill-switch', { mode }, () => (mode === 'off' ? 'Normal trading resumed.' : mode === 'halt' ? 'New buys paused. Existing positions stay protected.' : 'Selling everything; the engine stops when done.'));
  };

  const buttons = (
    <div className="flex flex-wrap gap-2">
      {!running ? (
        <button type="button" className="btn" onClick={start} disabled={!c.canControl || live || a.busy !== null || !c.available}>
          ▶ {a.busy === 'start' ? 'Starting…' : 'Start engine'}
        </button>
      ) : (
        <button type="button" className="btn-ghost border-down/40 text-down hover:bg-down/10" onClick={stop} disabled={!c.canControl || a.busy !== null || c.engine?.stopRequested}>
          ■ {a.busy === 'stop' ? 'Stopping…' : 'Stop engine'}
        </button>
      )}
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          {line.badge}
          {c.canControl && !live && buttons}
        </div>
        {a.error && <ErrorBox message={a.error} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {line.badge}
        <span className="text-sm text-slate-400">{line.text}</span>
      </div>
      {live && <ErrorBox message='TRADING_MODE in .env is "live". The website only runs the engine in paper mode; its buttons are disabled.' />}
      {c.canControl ? buttons : <ViewOnly />}
      {c.engine?.lastExit && !running && c.engine.lastExit.code !== 0 && (
        <div className="rounded-lg border border-down/30 bg-down/10 p-3 text-xs">
          <div className="mb-1 font-semibold text-down">The engine stopped at {istTime(c.engine.lastExit.at)} (exit code {String(c.engine.lastExit.code)}). Last output:</div>
          <pre className="whitespace-pre-wrap text-slate-300">{c.engine.lastExit.lines.join('\n') || '(no output)'}</pre>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold text-slate-300">Kill switch</h3>
        <p className="mb-2 text-xs text-slate-500">Works whether the engine was started here or from a terminal.</p>
        <div className="flex flex-wrap gap-2">
          {([
            ['off', '✔ Normal', 'Trade as usual'],
            ['halt', '⏸ Pause new buys', 'No new buys; positions stay protected and managed'],
            ['flatten', '🛑 Sell everything & stop', 'Sell all paper positions at market, then stop'],
          ] as const).map(([mode, label, hint]) => (
            <button
              key={mode}
              type="button"
              title={hint}
              onClick={() => ks(mode)}
              disabled={!c.canControl || a.busy !== null || c.killSwitch === mode}
              className={`rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset transition disabled:cursor-default ${
                c.killSwitch === mode
                  ? mode === 'off'
                    ? 'bg-up/15 text-up ring-up/40'
                    : 'bg-down/15 text-down ring-down/40'
                  : 'text-slate-300 ring-ink-700 hover:bg-ink-800 disabled:opacity-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {a.notice && <p className="text-sm text-accent">{a.notice}</p>}
      {a.error && <ErrorBox message={a.error} />}
    </div>
  );
}

/** The engine's own log, newest at the bottom, refreshed every few seconds. */
export function EngineLog() {
  const { data: c } = useControl(4000);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [c?.log.length, c?.log.at(-1)]);
  if (!c) return null;
  return c.log.length === 0 ? (
    <Empty>No engine activity yet. Start the engine to see what it does.</Empty>
  ) : (
    <pre ref={box} className="thin-scroll max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-black p-3 text-[11px] leading-relaxed text-slate-300">
      {c.log.map((l) => l.replace(/^(\S+)T(\d\d:\d\d:\d\d)\.\d+Z /, (_m, d: string, t: string) => `${istTime(`${d}T${t}Z`).replace(' IST', '')} `)).join('\n')}
    </pre>
  );
}

const statusBadge = (o: ManualOrderView) =>
  o.status === 'done' ? <Badge color="green">Done</Badge> : o.status === 'rejected' ? <Badge color="red">Not done</Badge> : <Badge color="amber">Waiting for engine</Badge>;

export function ManualOrdersTable({ orders }: { orders: ManualOrderView[] }) {
  if (orders.length === 0) return <Empty>No orders placed from the website yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Time</th><th>Order</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td className="whitespace-nowrap text-xs text-slate-400">{istTime(o.requestedAt)}<div className="text-slate-500">by {o.requestedBy}</div></td>
              <td className="whitespace-nowrap"><b className={o.kind === 'buy' ? 'text-up' : 'text-down'}>{o.kind.toUpperCase()}</b> {o.symbol}{o.maxQty ? <span className="text-xs text-slate-500"> (max {o.maxQty})</span> : null}</td>
              <td>{statusBadge(o)}</td>
              <td className="text-xs text-slate-300">{o.message ?? 'The engine handles it on its next check (within a minute).'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Why the Buy/Sell buttons are disabled right now, if they are. */
export function orderBlocker(c: ControlView | null): string | null {
  if (!c) return 'Loading…';
  if (!c.canControl) return 'This account is view-only.';
  if (c.tradingMode !== 'paper') return 'Orders from the website work in paper trading only.';
  if (!c.market.open) return `The market is closed (${c.market.label}). Orders can be placed 09:15–15:30 IST on trading days.`;
  if (!c.engine?.running) return 'Start the engine first (Trading Engine page): it carries out orders with all the risk rules.';
  if (c.killSwitch === 'flatten') return 'The kill switch is set to "Sell everything & stop".';
  return null;
}

/** Buy form for the Paper Portfolio page. */
export function BuyForm({ control, reload }: { control: ControlView | null; reload: () => unknown }) {
  const [symbol, setSymbol] = useState('');
  const [qty, setQty] = useState('');
  const a = useAction(reload);
  const blocker = orderBlocker(control);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const s = symbol.trim().toUpperCase();
    if (!s) return;
    const n = qty.trim() ? Number(qty) : undefined;
    void a.run('buy', '/api/control/order', { kind: 'buy', symbol: s, ...(n !== undefined ? { maxQty: n } : {}) }, () => {
      setSymbol('');
      setQty('');
      return `Buy order for ${s} sent to the engine. The result appears below within a minute.`;
    });
  };
  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="min-w-[10rem] flex-1 text-sm">
          <span className="mb-1 block text-slate-400">NSE symbol</span>
          <input className="input uppercase placeholder:normal-case" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="e.g. TCS, RELIANCE" maxLength={20} required disabled={Boolean(blocker)} />
        </label>
        <label className="w-36 text-sm">
          <span className="mb-1 block text-slate-400">Max shares (optional)</span>
          <input className="input" inputMode="numeric" pattern="[0-9]*" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} placeholder="auto" disabled={Boolean(blocker)} />
        </label>
        <button className="btn" disabled={Boolean(blocker) || a.busy !== null}>{a.busy ? 'Sending…' : 'Buy (paper)'}</button>
      </form>
      <p className="text-xs text-slate-500">
        The engine decides the number of shares with the same risk rules as its own trades (about 1% of the account at risk, at most 20% in one stock, at most 5 positions) and places a stop-loss straight away. "Max shares" can only lower that number. Paper money only.
      </p>
      {blocker && control && <p className="text-sm text-amber-300">{blocker}</p>}
      {a.notice && <p className="text-sm text-accent">{a.notice}</p>}
      {a.error && <ErrorBox message={a.error} />}
    </div>
  );
}

/** Sell button for one position row. */
export function SellButton({ symbol, control, reload }: { symbol: string; control: ControlView | null; reload: () => unknown }) {
  const a = useAction(reload);
  const blocker = orderBlocker(control);
  const sell = () => {
    if (!window.confirm(`Sell all of ${symbol} at market (paper)?`)) return;
    void a.run('sell', '/api/control/order', { kind: 'sell', symbol }, () => null);
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" className="rounded-md px-2.5 py-1 text-xs font-semibold text-down ring-1 ring-inset ring-down/40 hover:bg-down/10 disabled:opacity-40" onClick={sell} disabled={Boolean(blocker) || a.busy !== null} title={blocker ?? `Sell ${symbol} at market`}>
        {a.busy ? 'Sending…' : 'Sell'}
      </button>
      {a.error && <span className="max-w-[12rem] text-[11px] text-down">{a.error}</span>}
    </span>
  );
}

const JOB_TEXT: Record<JobView['job'], { button: string; running: string; what: string }> = {
  study: { button: '↻ Refresh watchlist now', running: 'Studying 43 companies…', what: 'Runs the company study (about 2 minutes) and saves a new watchlist for the engine.' },
  backtest: { button: '▶ Run backtest now', running: 'Running the backtest…', what: 'Re-runs the portfolio backtest against the NIFTY 50 (a few minutes) and updates the charts.' },
};

/** Button + live output for a background job (Watchlist and Backtesting pages). */
export function JobRunner({ job, onDone }: { job: JobView['job']; onDone?: () => unknown }) {
  const { data: c, reload } = useControl(3000);
  const a = useAction(reload);
  const current = c?.job?.job === job ? c.job : null;
  const other = c?.job && c.job.job !== job && c.job.state === 'running' ? c.job : null;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (current?.state === 'running') wasRunning.current = true;
    else if (wasRunning.current && current) {
      wasRunning.current = false;
      if (current.state === 'succeeded') void onDone?.();
    }
  }, [current?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null;
  const t = JOB_TEXT[job];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {c.canControl ? (
          <button type="button" className="btn" disabled={a.busy !== null || current?.state === 'running' || Boolean(other)} onClick={() => void a.run('job', '/api/control/job', { job })}>
            {current?.state === 'running' ? t.running : t.button}
          </button>
        ) : (
          <ViewOnly />
        )}
        <span className="text-xs text-slate-500">{other ? `Another job is running (${other.job}); wait for it to finish.` : t.what}</span>
      </div>
      {current && (
        <div>
          <div className="mb-1 text-xs">
            {current.state === 'running' ? <Badge color="amber">Running</Badge> : current.state === 'succeeded' ? <Badge color="green">Finished</Badge> : <Badge color="red">Failed</Badge>}{' '}
            <span className="text-slate-500">started {istTime(current.startedAt)} by {current.startedBy}{current.finishedAt ? `, finished ${istTime(current.finishedAt)}` : ''}</span>
          </div>
          <pre className="thin-scroll max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-black p-3 text-[11px] leading-relaxed text-slate-300">{current.lines.join('\n') || 'Starting…'}</pre>
        </div>
      )}
      {a.error && <ErrorBox message={a.error} />}
    </div>
  );
}
