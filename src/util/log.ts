import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let logFile: string | undefined;

export function setLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
  (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(line);
  if (logFile) appendFileSync(logFile, line + '\n');
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
};
