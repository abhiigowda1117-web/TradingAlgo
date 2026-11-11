import { findMetric, type FundamentalsSection } from './fundamentals';
import type { PeerRow } from './peers';
import type { StatementPeriod, Unit } from './types';

/**
 * "If Warren Buffett read this company": his published tests applied to the company's own annual
 * statements. Every figure is calculated from reported numbers; a test with too little data is Not
 * Available, never guessed. Thresholds Buffett stated himself are used as stated (e.g. "little or no
 * debt", ROE "without undue leverage"); where he gave no number, the threshold is AlgoTrade's reading
 * and says so. Questions only a person can answer (does the business have a moat? is management
 * honest?) are marked as judgement, with what the numbers hint.
 */

export type BuffettVerdict = 'meets' | 'close' | 'fails' | 'na' | 'judgement' | 'notApplicable';
export type BuffettGroup = 'Business' | 'Financial' | 'Management' | 'Value';

export interface BuffettFigure {
  label: string;
  value: number | null;
  unit: Unit;
}

export interface BuffettCheck {
  key: string;
  group: BuffettGroup;
  /** The question Buffett asks. */
  question: string;
  /** What he wants, in plain words (with the threshold used). */
  buffettWants: string;
  /** What this company's figures actually show. */
  reality: string;
  verdict: BuffettVerdict;
  figures: BuffettFigure[];
}

export interface BuffettValuation {
  /** Owner earnings stand-in: average free cash flow (operating cash flow − all capex), or average profit for banks. */
  ownerEarnings: number | null;
  basis: string;
  marketCap: number | null;
  price: number | null;
  ownerEarningsYield: number | null;
  earningsYield: number | null;
  /** Default assumptions for the value check (the website lets the reader change them). */
  defaults: { growth: number; growthBasis: string; discountRate: number; terminalGrowth: number; years: number; marginOfSafety: number };
  /** Estimated value of the whole company with the default assumptions, and the price's discount to it. */
  estimatedValue: number | null;
  discountToValue: number | null;
}

export interface BuffettAnalysis {
  periods: string[];
  financialSector: boolean;
  checks: BuffettCheck[];
  score: { met: number; close: number; failed: number; measurable: number; judgement: number };
  verdict: 'strong' | 'mixed' | 'weak' | 'insufficient';
  summary: string;
  strengths: string[];
  weaknesses: string[];
  valuation: BuffettValuation;
  notes: string[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const cr = (v: number) => `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} cr`;
const yr = (p: StatementPeriod) => p.periodEnd.slice(0, 4);
const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fcfOf = (p: StatementPeriod) => (ok(p.freeCashFlow) ? p.freeCashFlow : ok(p.operatingCashFlow) && ok(p.capex) ? p.operatingCashFlow + p.capex : null);

export const isFinancialSector = (sector: string | null | undefined, industry?: string | null) =>
  /financial/i.test(sector ?? '') || /\b(bank|insurance|nbfc|credit services|capital markets|asset management)\b/i.test(industry ?? '');

/**
 * Discounted value of a stream of owner earnings: `years` of growth at `g`, then growth at `gT` forever,
 * discounted at `r`. Null when the inputs cannot give a value (no positive earnings, or r <= gT).
 */
export function discountedValue(ownerEarnings: number, g: number, r: number, gT: number, years = 10): number | null {
  if (!(ownerEarnings > 0) || !(r > gT) || r <= -1 || ![g, r, gT].every(Number.isFinite)) return null;
  let v = 0;
  let oe = ownerEarnings;
  for (let t = 1; t <= years; t++) {
    oe *= 1 + g;
    v += oe / (1 + r) ** t;
  }
  return v + (oe * (1 + gT)) / (r - gT) / (1 + r) ** years;
}

export const BUFFETT_DEFAULTS = { discountRate: 0.12, terminalGrowth: 0.05, years: 10, marginOfSafety: 0.25, maxGrowth: 0.15 };

interface Inputs {
  fundamentals: FundamentalsSection;
  sector: string | null;
  industry: string | null;
  officers: { name: string; title: string }[];
  price: number | null;
  peerMedians: Omit<PeerRow, 'symbol' | 'name' | 'error'> | null;
}

export function buffettAnalysis(x: Inputs): BuffettAnalysis {
  const f = x.fundamentals;
  const annual = [...f.annual].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const fin = isFinancialSector(x.sector, x.industry);
  const n = annual.length;
  const first = annual[0];
  const last = annual.at(-1);
  const span = first && last && n >= 2 ? `${yr(first)}–${yr(last)}` : last ? yr(last) : '';
  const checks: BuffettCheck[] = [];
  const add = (c: BuffettCheck) => checks.push(c);
  const tooShort = (need: number) => `Not Available: needs at least ${need} years of annual statements (the data source gave ${n}).`;

  // ---------------- Business
  add({
    key: 'understand',
    group: 'Business',
    question: 'Do I understand this business?',
    buffettWants: 'A simple business he can explain, inside his "circle of competence". If he cannot judge where it will be in 10 years, he passes.',
    reality: `${[x.sector, x.industry].filter(Boolean).join(' · ') || 'Sector Not Available'}. Only you can answer this: can you explain in two sentences how it makes money, and why it will still make money in 10 years?`,
    verdict: 'judgement',
    figures: [],
  });

  const ni = annual.map((p) => p.netIncome);
  const niOk = ni.filter(ok);
  {
    let verdict: BuffettVerdict = 'na';
    let reality = tooShort(3);
    if (niOk.length >= 3) {
      const losses = annual.filter((p) => ok(p.netIncome) && p.netIncome <= 0).map(yr);
      const revUp = annual.slice(1).filter((p, i) => ok(p.revenue) && ok(annual[i]!.revenue) && p.revenue > annual[i]!.revenue!).length;
      const firstNi = niOk[0]!;
      const lastNi = niOk.at(-1)!;
      verdict = losses.length ? 'fails' : lastNi > firstNi ? 'meets' : 'close';
      reality = losses.length
        ? `Made a loss in ${losses.join(', ')}. Buffett avoids companies without a steady record (and "turnarounds").`
        : `Profitable in all ${niOk.length} years (${span}); profit ${lastNi > firstNi ? 'grew' : 'did not grow'} from ${cr(firstNi)} to ${cr(lastNi)}; revenue rose in ${revUp} of ${n - 1} years.`;
    }
    add({
      key: 'consistency',
      group: 'Business',
      question: 'Has it shown consistent earning power?',
      buffettWants: 'Profits every year and a rising trend: "demonstrated consistent earning power (future projections are of no interest to us, nor are turnaround situations)".',
      reality,
      verdict,
      figures: annual.map((p) => ({ label: `Net profit ${yr(p)}`, value: p.netIncome, unit: 'INR' as Unit })),
    });
  }

  const opm = annual.map((p) => (ok(p.operatingIncome) && ok(p.revenue) && p.revenue > 0 ? p.operatingIncome / p.revenue : null));
  const opmOk = opm.filter(ok);
  let marginsStable: boolean | null = null;
  {
    let verdict: BuffettVerdict = 'na';
    let reality = tooShort(3);
    if (fin) {
      verdict = 'notApplicable';
      reality = 'Not applicable to banks and insurers: they have no operating margin in the usual sense. Judge pricing power from the cost of deposits and the quality of loans.';
    } else if (opmOk.length >= 3) {
      const range = Math.max(...opmOk) - Math.min(...opmOk);
      const change = opmOk.at(-1)! - opmOk[0]!;
      marginsStable = range <= 0.05 && change >= -0.01;
      verdict = marginsStable ? 'meets' : range <= 0.1 && change >= -0.05 ? 'close' : 'fails';
      reality = `Operating margin ${opmOk.map(pct).join(' → ')} (${span}): ${change >= 0 ? 'held or rose' : `fell ${pct(-change)}`}, swinging ${pct(range)} between the best and worst year. ${marginsStable ? 'Stable margins through rising costs hint that it can raise prices.' : 'Unstable or falling margins hint at weak pricing power.'}`;
    }
    add({
      key: 'pricingPower',
      group: 'Business',
      question: 'Can it raise prices without losing customers (pricing power)?',
      buffettWants: '"The single most important decision in evaluating a business is pricing power." Evidence: margins that stay steady or rise year after year (AlgoTrade test: within a 5-point range and not falling).',
      reality,
      verdict,
      figures: annual.map((p, i) => ({ label: `Operating margin ${yr(p)}`, value: opm[i] ?? null, unit: 'pct' as Unit })),
    });
  }

  const roe = annual.map((p) => (ok(p.netIncome) && ok(p.equity) && p.equity > 0 ? p.netIncome / p.equity : null));
  const roeOk = roe.filter(ok);
  const roeAllHigh = roeOk.length >= 3 && roeOk.every((r) => r >= 0.15);
  add({
    key: 'moat',
    group: 'Business',
    question: 'Does it have a durable competitive advantage (a "moat")?',
    buffettWants: 'A lasting edge competitors cannot copy: a loved brand, lowest costs, a network, high switching costs or a licence. "A truly great business must have an enduring moat that protects excellent returns on invested capital."',
    reality:
      roeOk.length < 3
        ? 'The numbers are too short to give a hint. Name the moat yourself, and ask whether it is getting wider or narrower.'
        : roeAllHigh && marginsStable !== false
          ? `The numbers are consistent with a moat: return on equity stayed at or above 15% every year${marginsStable ? ' and margins were stable' : ''}. Numbers only hint at a moat; name it yourself and ask whether it is widening.`
          : `The numbers do not show a moat yet: ${!roeAllHigh ? 'return on equity was below 15% in some years' : 'margins were unstable'}. A real moat usually shows up as high, steady returns.`,
    verdict: 'judgement',
    figures: [],
  });

  // ---------------- Financial
  {
    let verdict: BuffettVerdict = 'na';
    let reality = tooShort(3);
    if (roeOk.length >= 3) {
      const a = avg(roeOk);
      verdict = roeAllHigh ? 'meets' : a >= 0.15 || roeOk.every((r) => r >= 0.12) ? 'close' : 'fails';
      reality = `Return on equity ${roeOk.map(pct).join(' → ')} (average ${pct(a)}).${roeAllHigh ? '' : ` Below 15% in ${roeOk.filter((r) => r < 0.15).length} of ${roeOk.length} years.`}`;
    }
    add({
      key: 'roe',
      group: 'Financial',
      question: 'Does it earn a high return on the owners\' money?',
      buffettWants: '"The primary test of managerial economic performance is the achievement of a high earnings rate on equity capital employed (without undue leverage...)." AlgoTrade test: 15% or more every year.',
      reality,
      verdict,
      figures: annual.map((p, i) => ({ label: `ROE ${yr(p)}`, value: roe[i] ?? null, unit: 'pct' as Unit })),
    });
  }

  {
    let verdict: BuffettVerdict = 'na';
    let reality = 'Not Available: no debt figures from the data source.';
    const figures: BuffettFigure[] = [];
    if (fin) {
      verdict = 'notApplicable';
      reality = 'Not applicable to banks and insurers: deposits and policies are their raw material, so debt/equity means something different. Buffett looks at capital strength and loan losses instead.';
    } else if (last) {
      const de = ok(last.totalDebt) && ok(last.equity) && last.equity > 0 ? last.totalDebt / last.equity : findMetric(f.metrics, 'debtToEquity');
      const yearsToRepay = ok(last.totalDebt) && ok(last.netIncome) && last.netIncome > 0 ? last.totalDebt / last.netIncome : null;
      figures.push({ label: 'Debt / equity', value: de, unit: 'ratio' }, { label: 'Years of profit to repay all debt', value: yearsToRepay, unit: 'ratio' }, { label: 'Total debt', value: last.totalDebt, unit: 'INR' });
      if (ok(de)) {
        const lowDebt = de <= 0.5 && (yearsToRepay === null || yearsToRepay <= 3);
        verdict = lowDebt ? 'meets' : de <= 1 && (yearsToRepay === null || yearsToRepay <= 5) ? 'close' : 'fails';
        reality = `Debt/equity ${de.toFixed(2)}${ok(yearsToRepay) ? `; all debt could be repaid from ${yearsToRepay.toFixed(1)} years of profit` : ''} (${yr(last)}).`;
      }
    }
    add({
      key: 'debt',
      group: 'Financial',
      question: 'Does it carry little or no debt?',
      buffettWants: 'Good returns "while employing little or no debt". AlgoTrade test: debt/equity at most 0.5 and debt repayable from 3 years of profit.',
      reality,
      verdict,
      figures,
    });
  }

  {
    const nm = annual.map((p) => (ok(p.netIncome) && ok(p.revenue) && p.revenue > 0 ? p.netIncome / p.revenue : null));
    const latestNm = nm.filter(ok).at(-1) ?? null;
    const latestOpm = opmOk.at(-1) ?? null;
    const peerOpm = x.peerMedians?.operatingMargin ?? null;
    let verdict: BuffettVerdict = 'na';
    let reality = 'Not Available: no margin figures.';
    if (fin) {
      verdict = 'notApplicable';
      reality = 'Not applicable to banks and insurers; see return on equity.';
    } else if (ok(latestNm)) {
      const beatsPeers = ok(peerOpm) && ok(latestOpm) ? latestOpm >= peerOpm : null;
      verdict = latestNm >= 0.1 && beatsPeers !== false ? 'meets' : latestNm >= 0.07 || beatsPeers === true ? 'close' : 'fails';
      reality = `Net margin ${pct(latestNm)}${ok(latestOpm) ? `, operating margin ${pct(latestOpm)}` : ''} (${last ? yr(last) : ''})${ok(peerOpm) ? `; peers' median operating margin ${pct(peerOpm)}, so it is ${beatsPeers ? 'better' : 'worse'} than its peers` : '; no peers to compare with'}.`;
    }
    add({
      key: 'margins',
      group: 'Financial',
      question: 'Are its profit margins high, and better than its rivals\'?',
      buffettWants: 'High margins and a management that keeps costs low. AlgoTrade test: net margin at least 10% and an operating margin no worse than its peers\'.',
      reality,
      verdict,
      figures: [{ label: 'Net margin (latest year)', value: latestNm, unit: 'pct' }, { label: 'Operating margin (latest year)', value: latestOpm, unit: 'pct' }, { label: 'Peers\' median operating margin', value: peerOpm, unit: 'pct' }],
    });
  }

  const fcf = annual.map(fcfOf);
  {
    let verdict: BuffettVerdict = 'na';
    let reality = tooShort(3);
    const pairs = annual.map((p, i) => [fcf[i], p.netIncome] as const).filter(([a, b]) => ok(a) && ok(b)) as [number, number][];
    if (fin) {
      verdict = 'notApplicable';
      reality = 'Not applicable to banks and insurers: their cash flow statements mix in customers\' money.';
    } else if (pairs.length >= 3) {
      const sumF = pairs.reduce((s, [a]) => s + a, 0);
      const sumN = pairs.reduce((s, [, b]) => s + b, 0);
      const conv = sumN > 0 ? sumF / sumN : null;
      const allPositive = pairs.every(([a]) => a > 0);
      verdict = ok(conv) && conv >= 0.8 && allPositive ? 'meets' : ok(conv) && conv >= 0.5 && sumF > 0 ? 'close' : 'fails';
      reality = `Free cash flow ${pairs.map(([a]) => cr(a)).join(' → ')}${ok(conv) ? `: ${Math.round(conv * 100)} paise of cash for every ₹1 of reported profit` : ''}${allPositive ? '' : '; negative in some years'}.`;
    }
    add({
      key: 'ownerEarnings',
      group: 'Financial',
      question: 'Are the profits real cash ("owner earnings")?',
      buffettWants: 'Owner earnings: profit plus depreciation, minus the capital spending needed just to stay competitive. Here estimated as free cash flow. AlgoTrade test: at least 80 paise of cash per ₹1 of profit, positive every year.',
      reality,
      verdict,
      figures: annual.map((p, i) => ({ label: `Free cash flow ${yr(p)}`, value: fcf[i] ?? null, unit: 'INR' as Unit })),
    });
  }

  {
    const both = annual.filter((p) => ok(p.capex) && ok(p.operatingCashFlow) && p.operatingCashFlow! > 0);
    let verdict: BuffettVerdict = 'na';
    let reality = tooShort(3);
    let share: number | null = null;
    if (fin) {
      verdict = 'notApplicable';
      reality = 'Not applicable to banks and insurers.';
    } else if (both.length >= 3) {
      share = both.reduce((s, p) => s - p.capex!, 0) / both.reduce((s, p) => s + p.operatingCashFlow!, 0);
      verdict = share <= 0.4 ? 'meets' : share <= 0.7 ? 'close' : 'fails';
      reality = `Spent ${pct(share)} of its operating cash flow on new plant and equipment (${span}). ${share <= 0.4 ? 'Most of the cash is left for the owners.' : 'Much of the cash has to go back into the business to keep it going or growing.'}`;
    }
    add({
      key: 'capitalLight',
      group: 'Financial',
      question: 'Does it need little capital to grow?',
      buffettWants: 'Like See\'s Candies: high returns that need little new capital, leaving cash for the owners. AlgoTrade test: capital spending at most 40% of operating cash flow.',
      reality,
      verdict,
      figures: [{ label: 'Capex / operating cash flow', value: share, unit: 'pct' }],
    });
  }

  {
    let verdict: BuffettVerdict = 'na';
    let reality = tooShort(3);
    let incremental: number | null = null;
    const withEq = annual.filter((p) => ok(p.netIncome) && ok(p.equity));
    if (withEq.length >= 3) {
      const a = withEq[0]!;
      const b = withEq.at(-1)!;
      const dE = b.equity! - a.equity!;
      const dN = b.netIncome! - a.netIncome!;
      if (dE <= 0) {
        verdict = dN > 0 ? 'meets' : 'fails';
        reality = dN > 0 ? `Profit grew by ${cr(dN)} without any growth in shareholders' equity: it paid out its profits and still grew.` : 'Neither equity nor profit grew.';
      } else {
        incremental = dN / dE;
        verdict = incremental >= 0.15 ? 'meets' : incremental >= 0.1 ? 'close' : 'fails';
        reality = `Shareholders' equity grew by ${cr(dE)} (${yr(a)}–${yr(b)}) and yearly profit by ${cr(dN)}: each ₹100 kept in the business added about ₹${(incremental * 100).toFixed(0)} of yearly profit.`;
      }
    }
    add({
      key: 'retained',
      group: 'Financial',
      question: 'Does every rupee it keeps create at least a rupee of value?',
      buffettWants: 'His "one-dollar test": each dollar of retained earnings should become at least a dollar of market value. AlgoTrade measures it as the extra yearly profit earned on the extra equity: at least 15%.',
      reality,
      verdict,
      figures: [{ label: 'Return on retained equity', value: incremental, unit: 'pct' }],
    });
  }

  // ---------------- Management
  {
    const dy = findMetric(f.metrics, 'dividendYield');
    const names = x.officers.slice(0, 3).map((o) => `${o.name} (${o.title})`).join('; ');
    add({
      key: 'management',
      group: 'Management',
      question: 'Is management able, honest and owner-minded?',
      buffettWants: 'Managers who are rational with spare cash (reinvest only at high returns, otherwise pay dividends or buy back shares below value), candid about mistakes, and who resist copying rivals (the "institutional imperative").',
      reality: `${names ? `Leadership: ${names}. ` : ''}${ok(dy) ? `Dividend yield ${pct(dy)}. ` : ''}Only you can judge this: read the last three annual-report letters. Do they admit mistakes? Do they avoid expensive takeovers and share dilution? Are the promoters' holdings stable and unpledged?`,
      verdict: 'judgement',
      figures: [{ label: 'Dividend yield', value: dy, unit: 'pct' }],
    });
  }

  // ---------------- Value
  const marketCap = findMetric(f.metrics, 'marketCap');
  const pe = findMetric(f.metrics, 'pe');
  const recent = (xs: (number | null)[]) => xs.slice(-3).filter(ok);
  const base = fin ? recent(ni) : recent(fcf);
  const ownerEarnings = base.length ? avg(base) : null;
  const basis = fin ? `Average net profit of the last ${base.length} years (banks: profit is the owner earnings)` : `Average free cash flow of the last ${base.length} years (operating cash flow minus all capital spending; Buffett would subtract only the spending needed to stay competitive, so this is conservative)`;
  const revCagr = findMetric(f.growth, 'revenueCagr');
  const profitCagr = findMetric(f.growth, 'profitCagr');
  const pastGrowth = [revCagr, profitCagr].filter(ok);
  const growth = pastGrowth.length ? Math.max(0, Math.min(BUFFETT_DEFAULTS.maxGrowth, ...pastGrowth)) : 0;
  const growthBasis = pastGrowth.length
    ? `The lower of its past revenue and profit growth (${pastGrowth.map(pct).join(' and ')}), capped at ${pct(BUFFETT_DEFAULTS.maxGrowth)}`
    : 'Past growth Not Available, so 0% (no growth assumed)';
  const estimatedValue = ok(ownerEarnings) ? discountedValue(ownerEarnings, growth, BUFFETT_DEFAULTS.discountRate, BUFFETT_DEFAULTS.terminalGrowth, BUFFETT_DEFAULTS.years) : null;
  const discountToValue = ok(estimatedValue) && ok(marketCap) && marketCap > 0 ? 1 - marketCap / estimatedValue : null;
  const valuation: BuffettValuation = {
    ownerEarnings,
    basis,
    marketCap,
    price: x.price,
    ownerEarningsYield: ok(ownerEarnings) && ok(marketCap) && marketCap > 0 ? ownerEarnings / marketCap : null,
    earningsYield: ok(pe) && pe > 0 ? 1 / pe : null,
    defaults: { growth, growthBasis, discountRate: BUFFETT_DEFAULTS.discountRate, terminalGrowth: BUFFETT_DEFAULTS.terminalGrowth, years: BUFFETT_DEFAULTS.years, marginOfSafety: BUFFETT_DEFAULTS.marginOfSafety },
    estimatedValue,
    discountToValue,
  };
  {
    let verdict: BuffettVerdict = 'na';
    let reality = 'Not Available: needs the market value and a few years of cash flow.';
    if (ok(ownerEarnings) && ownerEarnings <= 0) {
      verdict = 'fails';
      reality = 'It has not produced positive owner earnings recently, so there is nothing to value. Buffett would not pay for hope.';
    } else if (ok(discountToValue) && ok(estimatedValue) && ok(marketCap)) {
      verdict = discountToValue >= BUFFETT_DEFAULTS.marginOfSafety ? 'meets' : discountToValue >= 0 ? 'close' : 'fails';
      reality = `With the default assumptions below, the whole company is worth about ${cr(estimatedValue)}; the market price values it at ${cr(marketCap)}, which is ${discountToValue >= 0 ? `${pct(discountToValue)} below` : `${pct(-discountToValue)} above`} that estimate. Owner-earnings yield ${valuation.ownerEarningsYield !== null ? pct(valuation.ownerEarningsYield) : 'Not Available'}.`;
    }
    add({
      key: 'price',
      group: 'Value',
      question: 'Is the price sensible, with a margin of safety?',
      buffettWants: '"Price is what you pay; value is what you get." Value is the discounted cash the business will produce; he buys only well below it. AlgoTrade test: market value at least 25% below the estimate (change the assumptions below).',
      reality,
      verdict,
      figures: [{ label: 'Owner-earnings yield', value: valuation.ownerEarningsYield, unit: 'pct' }, { label: 'Earnings yield (1 / P/E)', value: valuation.earningsYield, unit: 'pct' }],
    });
  }

  // ---------------- Score and reading
  const count = (v: BuffettVerdict) => checks.filter((c) => c.verdict === v).length;
  const score = { met: count('meets'), close: count('close'), failed: count('fails'), measurable: count('meets') + count('close') + count('fails'), judgement: count('judgement') };
  const points = score.met + score.close / 2;
  const verdict: BuffettAnalysis['verdict'] = score.measurable < 4 ? 'insufficient' : points / score.measurable >= 0.75 ? 'strong' : points / score.measurable >= 0.5 ? 'mixed' : 'weak';
  const summary = {
    strong: 'On the numbers, this looks like the kind of business Buffett looks for. Before he bought, he would still need to understand it, trust its management and get a sensible price.',
    mixed: 'Mixed: it has some of the qualities Buffett looks for but fails others. He usually waits for a business that passes all of his tests.',
    weak: 'It fails several of Buffett\'s core tests. He would most likely pass and wait for a better business or a better price.',
    insufficient: 'There is too little data to apply most of Buffett\'s tests. He would not invest in what he cannot evaluate.',
  }[verdict];
  const short = (c: BuffettCheck) => c.question.replace(/\?$/, '');
  return {
    periods: annual.map((p) => p.periodEnd),
    financialSector: fin,
    checks,
    score,
    verdict,
    summary,
    strengths: checks.filter((c) => c.verdict === 'meets').map(short),
    weaknesses: checks.filter((c) => c.verdict === 'fails').map(short),
    valuation,
    notes: [
      'Thresholds Buffett never stated as numbers (15% ROE, 0.5 debt/equity, 25% margin of safety...) are AlgoTrade\'s reading of his principles, not his own figures.',
      `Based on ${n} years of annual statements from Yahoo Finance${span ? ` (${span})` : ''}. Buffett would study ten years or more, and read the annual reports himself.`,
      'Rule-based reading for learning, not a recommendation, and not a forecast or target price.',
    ],
  };
}
