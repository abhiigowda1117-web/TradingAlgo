import { useMemo, useState, type ReactNode } from 'react';
import { NA } from '../lib/format';
import type { BuffettAnalysis as BA, BuffettCheck, BuffettVerdict, Unit } from '../lib/researchTypes';
import { Badge, Card } from './ui';

/**
 * "Buffett's analysis" on the Company Research page: how Warren Buffett would read this company,
 * his checklist against the company's real figures, a margin-of-safety calculator with assumptions
 * the reader can change, and his complete strategy with sources.
 */

const BH = 'https://www.berkshirehathaway.com';
const LETTER = (y: number) => (y <= 1997 ? `${BH}/letters/${y}.html` : `${BH}/letters/${y}ltr.pdf`);

const VERDICT: Record<BuffettVerdict, { label: string; color: 'green' | 'amber' | 'red' | 'gray' | 'blue' }> = {
  meets: { label: 'Meets', color: 'green' },
  close: { label: 'Close', color: 'amber' },
  fails: { label: 'Fails', color: 'red' },
  na: { label: NA, color: 'gray' },
  notApplicable: { label: 'Not applicable', color: 'gray' },
  judgement: { label: 'Your judgement', color: 'blue' },
};
const Verdict = ({ v }: { v: BuffettVerdict }) => <span className="whitespace-nowrap"><Badge color={VERDICT[v].color}>{VERDICT[v].label}</Badge></span>;

function fmt(v: number | null, unit: Unit) {
  if (v === null || !Number.isFinite(v)) return NA;
  if (unit === 'pct') return `${(v * 100).toFixed(1)}%`;
  if (unit === 'INR') return `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`;
  return v.toFixed(2);
}
const cr = (v: number) => `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`;

/** Same formula as src/research/buffett.ts discountedValue. */
function discountedValue(oe: number, g: number, r: number, gT: number, years: number): number | null {
  if (!(oe > 0) || !(r > gT) || r <= -1 || ![g, r, gT].every(Number.isFinite)) return null;
  let v = 0;
  let x = oe;
  for (let t = 1; t <= years; t++) {
    x *= 1 + g;
    v += x / (1 + r) ** t;
  }
  return v + (x * (1 + gT)) / (r - gT) / (1 + r) ** years;
}

const Src = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{children}</a>
);

/** Buffett's whole approach, in the order he thinks, each with his words and where they come from. */
const STRATEGY: { title: string; body: string; quote?: string; source: ReactNode }[] = [
  {
    title: '1. Buy a piece of a business, not a ticker',
    body: 'A share is part-ownership of a real business. He asks what he would pay for the whole company if he could never sell it, and ignores daily price moves.',
    quote: 'Your goal as an investor should simply be to purchase, at a rational price, a part interest in an easily-understandable business whose earnings are virtually certain to be materially higher five, ten and twenty years from now.',
    source: <Src href={LETTER(1996)}>Berkshire letter, 1996</Src>,
  },
  {
    title: '2. Stay inside your circle of competence',
    body: 'He only judges businesses he understands well enough to say where they will be in ten years, and says "too hard" to the rest. That is why he avoided most technology for decades.',
    quote: 'The size of that circle is not very important; knowing its boundaries, however, is vital.',
    source: <Src href={LETTER(1996)}>Berkshire letter, 1996</Src>,
  },
  {
    title: '3. Demand a durable competitive advantage (a moat)',
    body: 'A brand people pay more for, the lowest costs, a network, high switching costs or a licence: something that keeps competitors from taking the profits away, and that is getting wider over time.',
    quote: 'A truly great business must have an enduring "moat" that protects excellent returns on invested capital.',
    source: <Src href={LETTER(2007)}>Berkshire letter, 2007</Src>,
  },
  {
    title: '4. Look for pricing power',
    body: 'A business that can raise prices without losing customers protects its owners against inflation. Steady or rising margins are the evidence.',
    quote: 'The single most important decision in evaluating a business is pricing power.',
    source: <Src href="https://ritholtz.com/2016/03/fcic-buffett/">Interview with the US Financial Crisis Inquiry Commission, 2010</Src>,
  },
  {
    title: '5. Judge returns on equity, not earnings per share',
    body: 'Earnings per share can rise just because profits are kept in the business. What matters is how much the business earns on the owners\' money, without borrowing to boost it.',
    quote: 'The primary test of managerial economic performance is the achievement of a high earnings rate on equity capital employed (without undue leverage, accounting gimmickry, etc.) and not the achievement of consistent gains in earnings per share.',
    source: <Src href={LETTER(1979)}>Berkshire letter, 1979</Src>,
  },
  {
    title: '6. Little or no debt',
    body: 'Debt turns a bad year into a disaster. Berkshire\'s published buying rules ask for businesses earning good returns on equity while employing little or no debt.',
    quote: 'Businesses earning good returns on equity while employing little or no debt.',
    source: <Src href={`${BH}/1996ar/acq.html`}>Berkshire acquisition criteria (annual reports)</Src>,
  },
  {
    title: '7. Count owner earnings, not accounting profit',
    body: 'Owner earnings are reported profit, plus depreciation and amortisation, minus the average capital spending the business needs just to keep its competitive position and volume. This is the cash an owner could really take out.',
    source: <Src href={LETTER(1986)}>Berkshire letter, 1986 (appendix)</Src>,
  },
  {
    title: '8. Prefer businesses that need little capital',
    body: 'His "dream business", See\'s Candies, grew its profits many times over while needing very little new money. Businesses that must pour cash into factories just to keep up leave little for the owners.',
    source: <Src href={LETTER(2007)}>Berkshire letter, 2007 (great, good and gruesome businesses)</Src>,
  },
  {
    title: '9. Every rupee kept must create at least a rupee of value',
    body: 'If a company keeps its profits instead of paying them out, each rupee kept should eventually add at least a rupee of market value. If it cannot, the money belongs with the shareholders.',
    source: <Src href={LETTER(1983)}>Berkshire letter, 1983</Src>,
  },
  {
    title: '10. Able, honest, owner-minded managers',
    body: 'He wants managers who reinvest only at high returns and otherwise return cash, who admit mistakes openly, and who resist copying rivals\' expensive moves. Even so, he warns that a bad business usually beats good managers.',
    quote: 'When a management with a reputation for brilliance tackles a business with a reputation for bad economics, it is the reputation of the business that remains intact.',
    source: <Src href={LETTER(1980)}>Berkshire letter, 1980</Src>,
  },
  {
    title: '11. Estimate intrinsic value, and buy with a margin of safety',
    body: 'Value is the cash the business will produce over its life, discounted back to today. He buys only when the price is well below his conservative estimate, so that mistakes in the estimate do not hurt badly (the "margin of safety" he learnt from Benjamin Graham).',
    quote: 'Price is what you pay; value is what you get.',
    source: <><Src href={`${BH}/ownman.pdf`}>Owner's Manual</Src> · <Src href={LETTER(2008)}>Berkshire letter, 2008</Src></>,
  },
  {
    title: '12. A wonderful company at a fair price beats a fair company at a wonderful price',
    body: 'Early on he bought cheap, poor businesses; he learnt that quality compounds and cheapness does not. He will pay a fair price for a great business.',
    quote: 'It\'s far better to buy a wonderful company at a fair price than a fair company at a wonderful price.',
    source: <Src href={LETTER(1989)}>Berkshire letter, 1989</Src>,
  },
  {
    title: '13. Use Mr. Market\'s moods; don\'t follow them',
    body: 'The market offers prices every day, sometimes far too high, sometimes far too low. Falls in good businesses are chances to buy; booms are times for caution.',
    quote: 'We simply attempt to be fearful when others are greedy and to be greedy only when others are fearful.',
    source: <><Src href={LETTER(1986)}>Berkshire letter, 1986</Src> · Mr. Market: <Src href={LETTER(1987)}>1987</Src></>,
  },
  {
    title: '14. Hold for a very long time, and concentrate',
    body: 'He makes few decisions, holds a few great businesses in size, and lets them compound. He sells when the business (not the price) gets worse, or when he finds a clearly better use for the money.',
    quote: 'Our favorite holding period is forever.',
    source: <><Src href={LETTER(1988)}>Berkshire letter, 1988</Src> · on concentration: <Src href={LETTER(1993)}>1993</Src></>,
  },
  {
    title: '15. What he avoids',
    body: 'Businesses he cannot understand, turnarounds ("turnarounds seldom turn"), heavy borrowing, companies that constantly need new capital, exciting stories without profits, and paying any price for growth.',
    source: <><Src href={LETTER(1979)}>Berkshire letter, 1979</Src> · <Src href={`${BH}/1996ar/acq.html`}>acquisition criteria</Src></>,
  },
  {
    title: '16. His advice for most people',
    body: 'For people who will not analyse businesses themselves, he recommends a very low-cost index fund held for the long term (in India, a NIFTY 50 index fund is the nearest equivalent). This matches the Strategy Lab result: holding the NIFTY 50 beat every trading strategy.',
    quote: 'Put 10% of the cash in short-term government bonds and 90% in a very low-cost S&P 500 index fund.',
    source: <Src href={LETTER(2013)}>Berkshire letter, 2013 (instructions for his wife's trust)</Src>,
  },
];

const STEPS: { title: string; keys: string[] }[] = [
  { title: 'Do I understand it?', keys: ['understand'] },
  { title: 'Will it be stronger in 10–20 years?', keys: ['consistency', 'moat', 'pricingPower'] },
  { title: 'Are the economics excellent?', keys: ['roe', 'debt', 'margins', 'ownerEarnings', 'capitalLight', 'retained'] },
  { title: 'Can I trust the people running it?', keys: ['management'] },
  { title: 'Is the price sensible?', keys: ['price'] },
];

function stepVerdict(checks: BuffettCheck[]): BuffettVerdict {
  const m = checks.filter((c) => c.verdict === 'meets' || c.verdict === 'close' || c.verdict === 'fails');
  if (!m.length) return checks.some((c) => c.verdict === 'judgement') ? 'judgement' : checks[0]?.verdict ?? 'na';
  if (m.some((c) => c.verdict === 'fails')) return m.every((c) => c.verdict === 'fails') || m.filter((c) => c.verdict === 'fails').length > m.length / 2 ? 'fails' : 'close';
  return m.every((c) => c.verdict === 'meets') ? 'meets' : 'close';
}

function Calculator({ v }: { v: BA['valuation'] }) {
  const d = v.defaults;
  const [growth, setGrowth] = useState((d.growth * 100).toFixed(1));
  const [rate, setRate] = useState((d.discountRate * 100).toFixed(1));
  const [terminal, setTerminal] = useState((d.terminalGrowth * 100).toFixed(1));
  const [mos, setMos] = useState((d.marginOfSafety * 100).toFixed(0));
  const out = useMemo(() => {
    if (v.ownerEarnings === null || v.marketCap === null) return null;
    const value = discountedValue(v.ownerEarnings, Number(growth) / 100, Number(rate) / 100, Number(terminal) / 100, d.years);
    if (value === null) return { error: v.ownerEarnings <= 0 ? 'No positive owner earnings to value.' : 'The discount rate must be higher than the long-term growth rate.' };
    const discount = 1 - v.marketCap / value;
    const perShare = v.price !== null && v.marketCap > 0 ? (value / v.marketCap) * v.price : null;
    const buyBelow = perShare !== null ? perShare * (1 - Number(mos) / 100) : null;
    return { value, discount, perShare, buyBelow };
  }, [v, growth, rate, terminal, mos, d.years]);

  const field = (label: string, val: string, set: (s: string) => void, hint: string) => (
    <label className="block text-xs">
      <span className="text-slate-400">{label}</span>
      <div className="mt-1 flex items-center gap-1">
        <input className="input w-20 py-1 text-right tabular-nums" inputMode="decimal" value={val} onChange={(e) => set(e.target.value)} />
        <span className="text-slate-500">%</span>
      </div>
      <span className="mt-0.5 block text-[11px] text-slate-500">{hint}</span>
    </label>
  );

  if (v.ownerEarnings === null) return <p className="text-sm text-slate-400">{NA}: not enough cash-flow data to estimate value.</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-300">
        Owner earnings used: <b>{cr(v.ownerEarnings)}</b> a year. <span className="text-slate-500">{v.basis}.</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        {field('Growth for the next 10 years', growth, setGrowth, d.growthBasis)}
        {field('Discount rate', rate, setRate, 'Your required return. Default 12%: AlgoTrade\'s assumption (a government bond yield plus a cushion).')}
        {field('Growth after year 10', terminal, setTerminal, 'Default 5% a year, forever.')}
        {field('Margin of safety', mos, setMos, 'How far below value you want to buy. Default 25%.')}
      </div>
      {out && 'error' in out ? (
        <p className="text-sm text-down">{out.error}</p>
      ) : out ? (
        <div className="grid gap-2 rounded-lg bg-ink-850 p-3 text-center text-sm sm:grid-cols-4">
          <div><div className="text-xs text-slate-500">Estimated value (whole company)</div><div className="font-semibold tabular-nums">{cr(out.value)}</div></div>
          <div><div className="text-xs text-slate-500">Market value now</div><div className="font-semibold tabular-nums">{cr(v.marketCap!)}</div></div>
          <div>
            <div className="text-xs text-slate-500">Price vs estimate</div>
            <div className={`font-semibold tabular-nums ${out.discount >= Number(mos) / 100 ? 'text-up' : out.discount >= 0 ? 'text-amber-300' : 'text-down'}`}>
              {out.discount >= 0 ? `${(out.discount * 100).toFixed(0)}% below` : `${(-out.discount * 100).toFixed(0)}% above`}
            </div>
          </div>
          <div><div className="text-xs text-slate-500">Buffett-style buy price (per share)</div><div className="font-semibold tabular-nums">{out.buyBelow !== null ? `below ₹${out.buyBelow.toFixed(0)}` : NA}</div></div>
        </div>
      ) : null}
      <p className="text-xs text-slate-500">
        An estimate from your assumptions, not a forecast or a target price. Small changes in growth or the discount rate change the value a lot, which is exactly why Buffett insists on a margin of safety and only values businesses whose future he can predict.
      </p>
    </div>
  );
}

export function BuffettAnalysis({ b, name, withStrategy = true }: { b: BA; name: string; withStrategy?: boolean }) {
  const byKey = new Map(b.checks.map((c) => [c.key, c]));
  const scoreColor = b.verdict === 'strong' ? 'green' : b.verdict === 'mixed' ? 'amber' : b.verdict === 'weak' ? 'red' : 'gray';
  return (
    <div className="space-y-4">
      <Card title={`If Warren Buffett read ${name}`}>
        <div className="flex flex-wrap items-center gap-3">
          <Badge color={scoreColor}>{b.score.met} met · {b.score.close} close · {b.score.failed} failed (of {b.score.measurable} measurable tests)</Badge>
          <span className="text-xs text-slate-500">+ {b.score.judgement} questions only you can answer</span>
        </div>
        <p className="mt-3 text-sm text-slate-200">{b.summary}</p>
        <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">How he would read it, in his order</p>
        <ol className="space-y-2">
          {STEPS.map((s, i) => {
            const cs = s.keys.map((k) => byKey.get(k)).filter((c): c is BuffettCheck => !!c);
            return (
              <li key={s.title} className="flex gap-3 rounded-lg bg-ink-850 p-2.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">{s.title} <Verdict v={stepVerdict(cs)} /></div>
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-400">{cs.map((c) => <li key={c.key}><span className="text-slate-300">{c.question}</span> {c.reality}</li>)}</ul>
                </div>
              </li>
            );
          })}
        </ol>
        {(b.strengths.length > 0 || b.weaknesses.length > 0) && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 text-sm">
            <div><h4 className="mb-1 font-semibold text-up">What he would like</h4><ul className="list-disc space-y-0.5 pl-5 text-slate-300">{b.strengths.length ? b.strengths.map((s) => <li key={s}>{s}</li>) : <li>Nothing clearly passed.</li>}</ul></div>
            <div><h4 className="mb-1 font-semibold text-down">What would stop him</h4><ul className="list-disc space-y-0.5 pl-5 text-slate-300">{b.weaknesses.length ? b.weaknesses.map((s) => <li key={s}>{s}</li>) : <li>No test clearly failed.</li>}</ul></div>
          </div>
        )}
      </Card>

      <Card title="Buffett's checklist vs the reality">
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Buffett asks</th><th>What he wants</th><th>What {name} actually shows</th><th>Verdict</th></tr></thead>
            <tbody>
              {b.checks.map((c) => (
                <tr key={c.key} className="align-top">
                  <td className="min-w-40"><div className="text-[10px] uppercase tracking-wide text-slate-500">{c.group}</div><div className="font-medium">{c.question}</div></td>
                  <td className="min-w-56 text-xs text-slate-400">{c.buffettWants}</td>
                  <td className="min-w-64 text-xs text-slate-200">
                    {c.reality}
                    {c.figures.length > 0 && c.figures.length <= 6 && (
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">{c.figures.map((x) => <span key={x.label}>{x.label}: <span className="tabular-nums text-slate-400">{fmt(x.value, x.unit)}</span></span>)}</div>
                    )}
                  </td>
                  <td><Verdict v={c.verdict} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {b.financialSector && <p className="mt-2 text-xs text-amber-300/80">Bank / financial company: the debt, cash-flow and capital-spending tests do not apply, and value is estimated from profit.</p>}
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-slate-500">{b.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </Card>

      <Card title="Value check: what is it worth, Buffett's way?">
        <Calculator v={b.valuation} />
      </Card>

      {withStrategy && <BuffettStrategy />}
    </div>
  );
}

/** Warren Buffett's complete strategy: 16 principles with his words and sources. */
export function BuffettStrategy() {
  return (
    <Card title="Warren Buffett's complete strategy">
      <p className="mb-3 text-sm text-slate-300">
        Buffett never published a formula. These are the principles he has explained in 60 years of letters to Berkshire Hathaway shareholders, in his own words where possible. The company checklist tests the ones that numbers can measure.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {STRATEGY.map((s) => (
          <section key={s.title} className="rounded-lg border border-ink-700 bg-ink-850 p-3">
            <h4 className="text-sm font-semibold">{s.title}</h4>
            <p className="mt-1 text-xs text-slate-300">{s.body}</p>
            {s.quote && <blockquote className="mt-2 border-l-2 border-accent/50 pl-2 text-xs italic text-slate-400">“{s.quote}”</blockquote>}
            <p className="mt-1.5 text-[11px] text-slate-500">Source: {s.source}</p>
          </section>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Further reading: Robert Hagstrom, <i>The Warren Buffett Way</i> (his 12 tenets: business, management, financial and value); Lawrence Cunningham, <i>The Essays of Warren Buffett</i>; Frazzini, Kabiller &amp; Pedersen, <i>Buffett's Alpha</i> (2018).
      </p>
    </Card>
  );
}
