import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Empty engine file paths in a temp dir (nothing written: the engine has not run). */
export function engineFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'web-'));
  const f = { state: join(dir, 'state.json'), paperAccount: join(dir, 'paper.json'), trades: join(dir, 'trades.jsonl'), engineLog: join(dir, 'engine.log'), heartbeat: join(dir, 'heartbeat.json'), killSwitch: join(dir, 'STOP'), watchlist: join(dir, 'watchlist.json') };
  return { dir, f };
}
