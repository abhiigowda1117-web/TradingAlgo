export const NA = 'Not Available';

const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export const inr = (v: number | null | undefined, dp = 0) => (ok(v) ? `₹${v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}` : NA);

/** ₹ in crore / lakh for large amounts. */
export const inrShort = (v: number | null | undefined) => {
  if (!ok(v)) return NA;
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 2 })} cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L`;
  return inr(v);
};

/** A fraction (0.05) as a percentage (5.0%). */
export const pct = (v: number | null | undefined, dp = 1) => (ok(v) ? `${v >= 0 ? '' : '−'}${Math.abs(v * 100).toFixed(dp)}%` : NA);
/** Signed fraction as +5.0% / −5.0%. */
export const signedPct = (v: number | null | undefined, dp = 2) => (ok(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(dp)}%` : NA);
/** A value already in percent (1.5 = 1.5%). */
export const signedPoints = (v: number | null | undefined, dp = 2) => (ok(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}%` : NA);
export const num = (v: number | null | undefined, dp = 2) => (ok(v) ? v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : NA);

export const tone = (v: number | null | undefined) => (!ok(v) || v === 0 ? 'text-slate-300' : v > 0 ? 'text-up' : 'text-down');

export const istTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST' : NA;

export const ago = (seconds: number | null | undefined) => {
  if (!ok(seconds)) return NA;
  if (seconds < 90) return `${Math.round(seconds)} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
};
