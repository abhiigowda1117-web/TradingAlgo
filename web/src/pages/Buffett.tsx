import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { BuffettAnalysis, BuffettStrategy } from '../components/BuffettAnalysis';
import { Card, ErrorBox, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import type { ResearchReport } from '../lib/researchTypes';

/**
 * Buffett's Strategy: his complete approach, and his checklist applied to any NSE company
 * (uses the same research data as Company Research; read-only, never trades).
 */
export function Buffett() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q) {
      setReport(null);
      return;
    }
    let live = true;
    setInput(q);
    setBusy(true);
    setError(null);
    (async () => {
      try {
        let r = await api<ResearchReport>(`/api/research?${new URLSearchParams({ q })}`);
        if (!r.buffett) r = await api<ResearchReport>(`/api/research?${new URLSearchParams({ q, refresh: '1' })}`);
        if (live) setReport(r);
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [q]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (input.trim()) setParams({ q: input.trim() });
  }

  return (
    <>
      <PageHeader title="Buffett's Strategy" description="Warren Buffett's complete investing strategy, and his checklist applied to any NSE company with its real figures. Research only; it never places orders." />
      <div className="space-y-4">
        <Card title="Check a company the Buffett way">
          <form onSubmit={submit} className="flex flex-wrap gap-2">
            <input className="input max-w-sm flex-1" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Company name or NSE symbol, e.g. ASIANPAINT" aria-label="Company" />
            <button className="btn" disabled={busy || !input.trim()}>{busy ? 'Analysing…' : '🎩 Analyse like Buffett'}</button>
          </form>
          {busy && <p className="mt-2 text-sm text-slate-400">Reading {q}'s annual reports, cash flow and debt… (about 10–30 seconds)</p>}
        </Card>
        {error && <ErrorBox message={error} />}
        {report?.buffett && !busy && <BuffettAnalysis b={report.buffett} name={report.overview.name ?? report.symbol} withStrategy={false} />}
        <BuffettStrategy />
      </div>
    </>
  );
}
