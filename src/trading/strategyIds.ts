/** Strategy identifiers (kept separate so config, engine and web server can share them without imports of trading code). */
export const STRATEGY_IDS = ['ema548'] as const;
export type StrategyName = (typeof STRATEGY_IDS)[number];
export const DEFAULT_STRATEGY: StrategyName = 'ema548';
export const isStrategyName = (v: unknown): v is StrategyName => typeof v === 'string' && (STRATEGY_IDS as readonly string[]).includes(v);
