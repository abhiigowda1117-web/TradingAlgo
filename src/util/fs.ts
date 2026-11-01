import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Writes JSON via a temp file and rename, so a crash mid-write never leaves a truncated file.
 * rename() is atomic on the same filesystem.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/** Reads JSON, or returns undefined if the file does not exist. Throws on corrupt JSON rather than starting fresh. */
export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}). Refusing to start with unknown state; fix or restore the file.`);
  }
}
