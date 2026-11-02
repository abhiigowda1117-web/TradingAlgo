/**
 * Indian equity delivery (CNC) charges, itemised. Defaults in config/trading.json follow a typical
 * discount-broker schedule; statutory rates change, so verify them against your broker's current
 * charges page before relying on the numbers.
 */
export interface CostSchedule {
  /** Brokerage as a fraction of order value (0 for most discount brokers on delivery). */
  brokeragePct: number;
  /** Cap on brokerage per order in INR; 0 means no cap. */
  brokerageMaxPerOrder: number;
  /** Securities Transaction Tax, charged on both buy and sell for delivery. */
  sttPct: number;
  /** Exchange transaction charge. */
  exchangePct: number;
  /** SEBI turnover fee. */
  sebiPct: number;
  /** Stamp duty, buy side only. */
  stampBuyPct: number;
  /** GST rate applied to brokerage + exchange charge + SEBI fee. */
  gstPct: number;
  /** Depository charge per scrip per sell day, INR incl. GST. */
  dpChargePerSell: number;
}

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  dp: number;
  total: number;
}

export function tradeCosts(side: 'BUY' | 'SELL', value: number, s: CostSchedule): CostBreakdown {
  if (!(value > 0)) return { brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, dp: 0, total: 0 };
  const rawBrokerage = value * s.brokeragePct;
  const brokerage = s.brokerageMaxPerOrder > 0 ? Math.min(rawBrokerage, s.brokerageMaxPerOrder) : rawBrokerage;
  const stt = value * s.sttPct;
  const exchange = value * s.exchangePct;
  const sebi = value * s.sebiPct;
  const stamp = side === 'BUY' ? value * s.stampBuyPct : 0;
  const gst = (brokerage + exchange + sebi) * s.gstPct;
  const dp = side === 'SELL' ? s.dpChargePerSell : 0;
  return { brokerage, stt, exchange, sebi, stamp, gst, dp, total: brokerage + stt + exchange + sebi + stamp + gst + dp };
}

/** Percentage costs of the more expensive side, for sizing (fixed DP charge excluded). */
export function approxCostPct(s: CostSchedule): number {
  const shared = s.sttPct + (s.brokeragePct + s.exchangePct + s.sebiPct) * (1 + s.gstPct);
  return shared + s.stampBuyPct;
}

/** Order value whose value + buy costs equals `budget`. */
export function affordableValue(budget: number, s: CostSchedule): number {
  // Buy costs are proportional to value (ignoring the brokerage cap, which only makes them smaller).
  const pct = tradeCosts('BUY', 1_000_000, s).total / 1_000_000;
  return budget / (1 + pct);
}
