import type { CompanyFundamentals } from '../types';

/**
 * Ratios the investor styles use, worked out from reported figures (never guessed: missing inputs give
 * missing outputs).
 * - Earnings yield = 1 / P/E (Greenblatt uses EBIT / enterprise value; the free data has no EBIT, so
 *   this is the common simplification).
 * - PEG = P/E ÷ earnings growth in percent (Peter Lynch); only for profitable, growing companies.
 * - P/E × P/B (Benjamin Graham's combined test, at most 22.5).
 */
export function withDerivedMetrics(f: CompanyFundamentals): CompanyFundamentals {
  const pe = f.pe !== undefined && f.pe > 0 ? f.pe : undefined;
  return {
    ...f,
    earningsYield: pe ? 1 / pe : undefined,
    peg: pe && f.earningsGrowth !== undefined && f.earningsGrowth > 0 ? pe / (f.earningsGrowth * 100) : undefined,
    peTimesPb: pe && f.pb !== undefined && f.pb > 0 ? pe * f.pb : undefined,
  };
}
