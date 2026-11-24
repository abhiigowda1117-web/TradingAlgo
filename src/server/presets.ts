import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeActiveProfile } from '../study/activeProfile';
import { writeActiveStrategy } from '../trading/activeStrategy';
import { requestStop, runningEngine } from '../trading/runLock';

/**
 * One-time settings changes the owner asked for, applied once when the website starts (paper only).
 * "autopilot-1": hold several quality companies and keep trading without anyone pressing buttons:
 * Warren Buffett's stock-picking style, the "Buy right, sit tight" strategy, and the engine kept running.
 * Anything chosen on the website afterwards wins; a preset is never applied twice.
 */
export function applyPresets(p: { presets: string; activeStrategy: string; activeProfile: string; engineWanted: string; engineLock?: string; engineStopRequest?: string }, tradingMode: 'paper' | 'live', now = new Date()): string[] {
  if (tradingMode !== 'paper') return [];
  let done: string[] = [];
  try {
    done = existsSync(p.presets) ? (JSON.parse(readFileSync(p.presets, 'utf8')) as { applied?: string[] }).applied ?? [] : [];
  } catch {
    done = [];
  }
  const applied: string[] = [];
  if (!done.includes('autopilot-1')) {
    writeActiveStrategy(p.activeStrategy, 'buyHold', 'autopilot', now);
    writeActiveProfile(p.activeProfile, 'buffett', 'autopilot', now);
    mkdirSync(dirname(p.engineWanted), { recursive: true });
    writeFileSync(p.engineWanted, 'on');
    applied.push('autopilot-1');
  }
  // "invest-80": invest about 80% of the money. The limits themselves are in config/trading.json
  // (up to 12 companies, 1.2% risk each, 80% total cap); a wider watchlist (Balanced style) gives enough
  // companies to fill it, and a running engine is restarted once so it uses the new limits.
  if (!done.includes('invest-80')) {
    writeActiveProfile(p.activeProfile, 'balanced', 'autopilot', now);
    if (p.engineLock && p.engineStopRequest && runningEngine(p.engineLock)) requestStop(p.engineStopRequest, 'autopilot (new limits)');
    applied.push('invest-80');
  }
  // "protection-1": loss protection (market filter, drawdown brake, per-sector limit) in the engine;
  // a running engine is restarted once to load it.
  if (!done.includes('protection-1')) {
    if (!applied.includes('invest-80') && p.engineLock && p.engineStopRequest && runningEngine(p.engineLock)) requestStop(p.engineStopRequest, 'autopilot (loss protection)');
    applied.push('protection-1');
  }
  if (applied.length) {
    mkdirSync(dirname(p.presets), { recursive: true });
    writeFileSync(p.presets, JSON.stringify({ applied: [...done, ...applied] }));
  }
  return applied;
}
