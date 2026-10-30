import type { CompareOp, ScreenRule, StudyConfig } from '../config';
import type { CompanyFundamentals } from '../types';

export interface RuleResult {
  rule: ScreenRule;
  value: number | undefined;
  passed: boolean;
}

export interface ScreenResult {
  passed: boolean;
  results: RuleResult[];
}

const compare: Record<CompareOp, (a: number, b: number) => boolean> = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
};

/** Applies every rule; a missing metric passes or fails according to `onMissing`. */
export function screen(f: CompanyFundamentals, cfg: StudyConfig['screen']): ScreenResult {
  const results = cfg.rules.map((rule) => {
    const value = f[rule.metric];
    const passed = value === undefined ? cfg.onMissing === 'pass' : compare[rule.op](value, rule.value);
    return { rule, value, passed };
  });
  return { passed: results.every((r) => r.passed), results };
}
