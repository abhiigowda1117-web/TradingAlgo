import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let logFile: string | undefined;
const secrets = new Set<string>();

export function setLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
}

/** Registers a value (API key, secret, token) that must never appear in logs. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) secrets.add(value);
}

/** Masks registered secrets and common credential patterns. */
export function redact(msg: string): string {
  let out = msg;
  for (const s of secrets) out = out.split(s).join('***');
  return out
    .replace(/(Authorization:\s*token\s+)[^\s,;]+/gi, '$1***')
    .replace(/\btoken\s+[A-Za-z0-9]+:[A-Za-z0-9]+/g, 'token ***:***')
    .replace(/\b(access_token|api_key|api_secret|request_token|checksum|enctoken)(["']?\s*[=:]\s*["']?)[^\s&"',}]+/gi, '$1$2***');
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${redact(msg)}`;
  (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(line);
  if (logFile) appendFileSync(logFile, line + '\n');
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
};
