import { useEffect, useState, type ReactNode } from 'react';
import { BullBearFight } from './BullBearFight';

export function Card({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-title">
          <span>{title}</span>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, valueClass = '' }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="card">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  green: 'bg-up/10 text-up ring-up/30',
  red: 'bg-down/10 text-down ring-down/30',
  amber: 'bg-amber-400/10 text-amber-300 ring-amber-400/30',
  blue: 'bg-accent/10 text-accent ring-accent/30',
  gray: 'bg-slate-500/10 text-slate-400 ring-slate-500/30',
};

export function Badge({ color = 'gray', children }: { color?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[color]}`}>{children}</span>;
}

/** Small bull-vs-bear fight while data loads. Waits 300 ms first so fast loads don't flash it. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(t);
  }, []);
  return show ? <BullBearFight size="sm" label={label} /> : <div className="h-32" aria-hidden="true" />;
}

export function ErrorBox({ message }: { message: string }) {
  return <p className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{message}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-sm text-slate-500">{children}</div>;
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-slate-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Placeholder for pages built in Phase 2: says what is coming and how to get it today. */
export function ComingSoon({ title, description, items, cli }: { title: string; description: string; items: string[]; cli?: string[] }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2">Planned for Phase 2 <Badge color="blue">Coming soon</Badge></span>}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
            {items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Card>
        {cli && (
          <Card title="Available today from the command line">
            <pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 text-xs text-slate-300">{cli.join('\n')}</pre>
          </Card>
        )}
      </div>
    </>
  );
}
