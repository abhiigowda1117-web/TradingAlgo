import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeActiveProfile } from '../study/activeProfile';
import { writeActiveStrategy } from '../trading/activeStrategy';

/**
 * One-time settings changes the owner asked for, applied once when the website starts (paper only).
 * "autopilot-1": hold several quality companies and keep trading without anyone pressing buttons:
 * Warren Buffett's stock-picking style, the "Buy right, sit tight" strategy, and the engine kept running.
 * Anything chosen on the website afterwards wins; a preset is never applied twice.
 */
export function applyPresets(p: { presets: string; activeStrategy: string; activeProfile: string; engineWanted: string }, tradingMode: 'paper' | 'live', now = new Date()): string[] {
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
  if (applied.length) {
    mkdirSync(dirname(p.presets), { recursive: true });
    writeFileSync(p.presets, JSON.stringify({ applied: [...done, ...applied] }));
  }
  return applied;
}
