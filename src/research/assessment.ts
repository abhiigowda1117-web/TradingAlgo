import { findMetric, type FundamentalsSection } from './fundamentals';
import type { ClassifiedNews } from './news';
import { median, type PeerRow } from './peers';
import type { TechnicalSection } from './technicals';
import type { Interpretation } from './types';

/**
 * Rule-based interpretation. Every statement is generated from the numbers by fixed thresholds,
 * names the numbers it used, and is labelled as interpretation in the report. Thresholds are rough
 * conventions, not universal truths (banks, for example, carry high debt by design). No price
 * targets and no predictions.
 */
export interface Assessment {
  businessQuality: Interpretation[];
  financialStrength: Interpretation[];
  growth: Interpretation[];
  risks: Interpretation[];
  valuation: Interpretation[];
  technical: Interpretation[];
  bullish: Interpretation[];
  bearish: Interpretation[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const inr = (x: number) => `₹${x.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const say = (text: string, ...basis: string[]): Interpretation => ({ text, basis });
const NA = (what: string): Interpretation => ({ text: `Insufficient data to assess ${what}.`, basis: [] });

export function assess(f: FundamentalsSection, t: TechnicalSection, news: ClassifiedNews[] | null, peers: PeerRow[], sector: string | null): Assessment {
  const m = (k: string) => findMetric([...f.metrics, ...f.growth], k);
  const roe = m('roe');
  const roce = m('roce');
  const opm = m('operatingMargin');
  const npm = m('netMargin');
  const de = m('debtToEquity');
  const cr = m('currentRatio');
  const fcf = m('freeCashFlow');
  const pe = m('pe');
  const pb = m('pb');
  const ev = m('evEbitda');
  const revCagr = m('revenueCagr');
  const profCagr = m('profitCagr');
  const revQ = m('revenueGrowthQoqYoy') ?? m('revenueGrowthYahoo');
  const profQ = m('profitGrowthQoqYoy') ?? m('earningsGrowthYahoo');
  const financial = /financial/i.test(sector ?? '');

  // ---- business quality
  const bq: Interpretation[] = [];
  if (roe !== null) {
    const level = roe >= 0.18 ? 'high' : roe >= 0.12 ? 'reasonable' : roe >= 0 ? 'low' : 'negative';
    bq.push(say(`Return on equity is ${level} at ${pct(roe)}${roce !== null ? `, with ROCE at ${pct(roce)}` : ''}.`, 'ROE', ...(roce !== null ? ['ROCE'] : [])));
  }
  const annual = f.annual.filter((p) => p.operatingMargin !== null);
  if (annual.length >= 3) {
    const a = annual[0]!.operatingMargin!;
    const b = annual.at(-1)!.operatingMargin!;
    const diff = b - a;
    bq.push(
      say(
        `Operating margin ${Math.abs(diff) < 0.02 ? 'has been broadly stable' : diff > 0 ? 'has expanded' : 'has contracted'} (${pct(a)} in ${annual[0]!.periodEnd.slice(0, 4)} to ${pct(b)} in ${annual.at(-1)!.periodEnd.slice(0, 4)}).`,
        'Annual operating margins',
      ),
    );
  } else if (opm !== null) bq.push(say(`Operating margin (TTM) is ${pct(opm)}${npm !== null ? `; net margin ${pct(npm)}` : ''}.`, 'Operating margin', 'Net margin'));
  const fcfYears = f.annual.filter((p) => p.freeCashFlow !== null || (p.operatingCashFlow !== null && p.capex !== null));
  if (fcfYears.length >= 2) {
    const pos = fcfYears.filter((p) => (p.freeCashFlow ?? p.operatingCashFlow! + p.capex!) > 0).length;
    bq.push(say(`Free cash flow was positive in ${pos} of the last ${fcfYears.length} reported years.`, 'Annual cash flow statements'));
  }
  if (!bq.length) bq.push(NA('business quality'));

  // ---- financial strength
  const fs: Interpretation[] = [];
  if (de !== null) {
    if (financial) fs.push(say(`Debt to equity is ${de.toFixed(2)}. For a financial company, leverage is part of the business model; judge it with capital-adequacy data instead.`, 'Debt to equity', 'Sector'));
    else fs.push(say(`Debt to equity of ${de.toFixed(2)} is ${de < 0.3 ? 'low' : de < 1 ? 'moderate' : de < 2 ? 'high' : 'very high'}.`, 'Debt to equity'));
  }
  if (cr !== null && !financial) fs.push(say(`Current ratio of ${cr.toFixed(2)} ${cr >= 1.5 ? 'indicates comfortable short-term liquidity' : cr >= 1 ? 'covers short-term obligations' : 'is below 1: short-term liabilities exceed current assets'}.`, 'Current ratio'));
  const la = f.annual.at(-1);
  if (la && la.operatingCashFlow !== null && la.netIncome !== null && la.netIncome > 0) {
    const conv = la.operatingCashFlow / la.netIncome;
    fs.push(say(`Operating cash flow was ${conv.toFixed(2)}× net profit in the latest year (${conv >= 0.8 ? 'profits are converting to cash' : 'weak cash conversion; check working capital'}).`, 'Operating cash flow', 'Net income'));
  }
  if (!fs.length) fs.push(NA('financial strength'));

  // ---- growth
  const gr: Interpretation[] = [];
  if (revCagr !== null) gr.push(say(`Revenue grew at ${pct(revCagr)} a year over the available annual history${profCagr !== null ? `; net profit at ${pct(profCagr)} a year` : ''}.`, 'Revenue CAGR', ...(profCagr !== null ? ['Profit CAGR'] : [])));
  if (revQ !== null) gr.push(say(`Latest quarter revenue changed ${pct(revQ)} year on year${profQ !== null ? `, net profit ${pct(profQ)}` : ''}.`, 'Quarterly growth'));
  if (!gr.length) gr.push(NA('growth'));

  // ---- risks and red flags
  const rk: Interpretation[] = [];
  if (npm !== null && npm < 0) rk.push(say('The company is loss-making on a trailing basis.', 'Net margin'));
  if (de !== null && de > 1.5 && !financial) rk.push(say(`High leverage (debt to equity ${de.toFixed(2)}).`, 'Debt to equity'));
  if (fcf !== null && fcf < 0) rk.push(say('Free cash flow is negative.', 'Free cash flow'));
  if (annual.length >= 3 && annual.at(-1)!.operatingMargin! - annual[0]!.operatingMargin! < -0.03) rk.push(say('Operating margin has fallen by more than 3 percentage points over the period.', 'Annual operating margins'));
  if (f.annual.length >= 2 && f.annual.at(-1)!.revenue !== null && f.annual.at(-2)!.revenue !== null && f.annual.at(-1)!.revenue! < f.annual.at(-2)!.revenue!) rk.push(say('Revenue declined in the latest year.', 'Annual revenue'));
  if (t.ema200 !== null && t.lastClose !== null && t.lastClose < t.ema200) rk.push(say('Price is below its 200-day average (long-term trend weak).', 'EMA 200'));
  const negNews = news?.filter((n) => n.sentiment < -0.2) ?? [];
  if (negNews.length >= 3) rk.push(say(`${negNews.length} recent headlines read negative (automated headline scoring); review them.`, 'News'));
  const peerPe = median(peers.map((p) => p.pe));
  if (pe !== null && peerPe !== null && pe > 2 * peerPe) rk.push(say(`P/E of ${pe.toFixed(1)} is more than twice the peer median (${peerPe.toFixed(1)}).`, 'P/E', 'Peer P/E'));
  const missing = [...f.metrics, ...f.growth].filter((x) => x.kind === 'unavailable').length;
  if (missing > 8) rk.push(say(`${missing} metrics are Not Available; conclusions rest on incomplete data.`, 'Data coverage'));
  if (!rk.length) rk.push(say('No red flags triggered by the automated checks (this does not mean there are none).', 'All checks'));

  // ---- valuation
  const va: Interpretation[] = [];
  if (pe !== null) {
    if (pe <= 0) va.push(say('P/E is not meaningful because earnings are negative.', 'P/E'));
    else if (peerPe !== null) va.push(say(`P/E of ${pe.toFixed(1)} vs peer median ${peerPe.toFixed(1)}: ${pe < peerPe * 0.8 ? 'cheaper than peers' : pe > peerPe * 1.2 ? 'more expensive than peers' : 'in line with peers'}.`, 'P/E', 'Peer P/E'));
    else va.push(say(`P/E is ${pe.toFixed(1)}. No peer group configured, so there is no relative comparison.`, 'P/E'));
  }
  const peerPb = median(peers.map((p) => p.pb));
  if (pb !== null) va.push(say(`Price to book is ${pb.toFixed(2)}${peerPb !== null ? ` (peer median ${peerPb.toFixed(2)})` : ''}.`, 'P/B'));
  if (ev !== null) va.push(say(`EV/EBITDA is ${ev.toFixed(1)}.`, 'EV/EBITDA'));
  if (pe !== null && pe > 0 && profCagr !== null && profCagr > 0) va.push(say(`P/E relative to profit growth (PEG-style) is ${(pe / (profCagr * 100)).toFixed(2)}; below 1 is often read as growth not fully priced in.`, 'P/E', 'Profit CAGR'));
  if (!va.length) va.push(NA('valuation'));

  // ---- technical outlook (describes the present, does not predict)
  const te: Interpretation[] = [];
  te.push(say(`Trend: ${t.trend.trend} (${t.trend.reason}).`, 'EMA 50', 'EMA 200'));
  if (t.rsi14 !== null) te.push(say(`RSI(14) is ${t.rsi14.toFixed(1)}: ${t.rsi14 > 70 ? 'overbought territory' : t.rsi14 < 30 ? 'oversold territory' : 'neutral range'}.`, 'RSI 14'));
  if (t.macd.histogram !== null) te.push(say(`${t.macd.state}.`, 'MACD'));
  const sup = t.supports[0];
  const res = t.resistances[0];
  if (t.lastClose !== null && (sup || res)) {
    te.push(say(`Nearest support ${sup ? `${inr(sup.price)} (${pct(1 - sup.price / t.lastClose)} below)` : 'Not Available'}; nearest resistance ${res ? `${inr(res.price)} (${pct(res.price / t.lastClose - 1)} above)` : 'Not Available'}.`, 'Swing highs/lows'));
  }
  te.push(say(`Volume: ${t.volume.trend}.`, 'Volume averages'));

  // ---- scenarios: conditions to watch, not forecasts
  const bull: Interpretation[] = [];
  const bear: Interpretation[] = [];
  if (res) bull.push(say(`A sustained move above resistance near ${inr(res.price)} would extend the price structure upward.`, 'Resistance'));
  if (sup) bear.push(say(`A close below support near ${inr(sup.price)} would weaken the price structure.`, 'Support'));
  if (revCagr !== null && revCagr > 0) bull.push(say(`Revenue growth continuing at or above its recent ${pct(revCagr)} annual pace would support the business case.`, 'Revenue CAGR'));
  if (annual.length >= 3) {
    bull.push(say('Operating margins holding at or above the latest level would support earnings.', 'Annual operating margins'));
    bear.push(say('Margin compression (costs rising faster than revenue) would pressure earnings.', 'Annual operating margins'));
  }
  if (de !== null && !financial) bear.push(say(`Rising debt from the current debt to equity of ${de.toFixed(2)} would raise financial risk.`, 'Debt to equity'));
  if (pe !== null && pe > 0) bear.push(say(`At a P/E of ${pe.toFixed(1)}, slower-than-expected earnings would leave the valuation exposed.`, 'P/E'));
  if (!bull.length) bull.push(NA('a bullish scenario'));
  if (!bear.length) bear.push(NA('a bearish scenario'));

  return { businessQuality: bq, financialStrength: fs, growth: gr, risks: rk, valuation: va, technical: te, bullish: bull, bearish: bear };
}
