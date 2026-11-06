import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { requestStop, runningEngine, stopRequested, type LockInfo } from '../../trading/runLock';

/**
 * Website controls for the paper engine and the background jobs. The engine and the jobs run as
 * separate programs (node + tsx on the project's own CLI files), so the web server itself never loads
 * trading or broker code. Paper only: the engine is never started when TRADING_MODE is live, and the
 * engine CLI itself refuses live mode without the --live flag, which this service never passes.
 */

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
export type JobName = 'study' | 'backtest';

export interface ControlPaths {
  root: string;
  engineLock: string;
  engineStopRequest: string;
  jobsLog: string;
}

export interface JobStatus {
  job: JobName;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  startedBy: string;
  lines: string[];
}

export interface EngineProcessStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  startedBy?: string;
  mode?: 'paper' | 'live';
  stopRequested: boolean;
  /** Set when an engine started from the website exited; shows why. */
  lastExit?: { at: string; code: number | null; lines: string[] };
}

export class ControlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const JOBS: Record<JobName, { label: string; args: string[] }> = {
  study: { label: 'Refresh watchlist (company study)', args: ['src/cli/study.ts'] },
  backtest: { label: 'Portfolio backtest vs NIFTY 50', args: ['src/cli/portfolio.ts', '--json', 'data/backtests/latest.json'] },
};
export const JOB_NAMES = Object.keys(JOBS) as JobName[];
const KEEP_LINES = 200;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Collects a child's output lines into a capped buffer (and optionally a log file). */
function collect(child: ChildProcess, into: string[], file?: string) {
  const out = file ? createWriteStream(file, { flags: 'a' }) : undefined;
  let partial = '';
  const onData = (chunk: Buffer) => {
    out?.write(chunk);
    const text = partial + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    partial = parts.pop() ?? '';
    for (const l of parts) if (l.trim()) into.push(l.replace(ANSI, ''));
    if (into.length > KEEP_LINES) into.splice(0, into.length - KEEP_LINES);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.once('close', () => {
    if (partial.trim()) into.push(partial.replace(ANSI, ''));
    out?.end();
  });
}

export class ControlService {
  private engineChild?: ChildProcess;
  private engineLines: string[] = [];
  private lastExit?: EngineProcessStatus['lastExit'];
  private job?: JobStatus;
  private jobChild?: ChildProcess;
  private readonly tsxCli: string;

  constructor(
    private p: ControlPaths,
    private o: { tradingMode: 'paper' | 'live'; spawn?: SpawnFn; now?: () => Date; stopTimeoutMs?: number },
  ) {
    this.tsxCli = createRequire(join(p.root, 'package.json')).resolve('tsx/cli');
  }

  private spawn(args: string[], startedBy: string): ChildProcess {
    const fn = this.o.spawn ?? nodeSpawn;
    return fn(process.execPath, [this.tsxCli, ...args], {
      cwd: this.p.root,
      env: { ...process.env, ALGOTRADE_STARTED_BY: startedBy, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  private now() {
    return (this.o.now ?? (() => new Date()))();
  }

  engineStatus(): EngineProcessStatus {
    const lock: LockInfo | undefined = runningEngine(this.p.engineLock);
    return {
      running: Boolean(lock),
      ...(lock ? { pid: lock.pid, startedAt: lock.startedAt, startedBy: lock.startedBy, mode: lock.mode } : {}),
      stopRequested: stopRequested(this.p.engineStopRequest),
      ...(this.lastExit ? { lastExit: this.lastExit } : {}),
    };
  }

  /** Starts the paper engine as a background program. Never live. */
  startEngine(username: string): EngineProcessStatus {
    if (this.o.tradingMode !== 'paper') throw new ControlError(403, 'The website only starts the engine in paper trading mode. TRADING_MODE in .env is not "paper".');
    const holder = runningEngine(this.p.engineLock);
    if (holder) throw new ControlError(409, `The engine is already running (started ${holder.startedBy === 'terminal' ? 'from a terminal' : `from the ${holder.startedBy}`}).`);
    if (this.engineChild && this.engineChild.exitCode === null) throw new ControlError(409, 'The engine is starting; give it a few seconds.');
    this.engineLines = [];
    this.lastExit = undefined;
    const child = this.spawn(['src/cli/trade.ts'], `website (${username})`);
    this.engineChild = child;
    collect(child, this.engineLines);
    child.once('close', (code) => {
      if (this.engineChild === child) this.engineChild = undefined;
      this.lastExit = { at: this.now().toISOString(), code, lines: this.engineLines.slice(-15) };
    });
    child.once('error', (e) => this.engineLines.push(`Could not start: ${e.message}`));
    return this.engineStatus();
  }

  /** Asks the engine to stop after its current check (works for an engine started from a terminal too). */
  stopEngine(username: string): EngineProcessStatus {
    if (!runningEngine(this.p.engineLock) && !this.engineChild) throw new ControlError(409, 'The engine is not running.');
    requestStop(this.p.engineStopRequest, username);
    // Safety net for an engine we started: if it has not exited after the timeout, end the process.
    const child = this.engineChild;
    if (child) {
      const t = setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, this.o.stopTimeoutMs ?? 120_000);
      t.unref?.();
    }
    return this.engineStatus();
  }

  jobStatus(): JobStatus | undefined {
    return this.job && { ...this.job, lines: this.job.lines.slice(-60) };
  }

  runJob(name: string, username: string): JobStatus {
    if (!JOB_NAMES.includes(name as JobName)) throw new ControlError(400, `Unknown job; choose ${JOB_NAMES.join(' or ')}`);
    if (this.job?.state === 'running') throw new ControlError(409, `"${JOBS[this.job.job].label}" is still running. Wait for it to finish.`);
    const job = name as JobName;
    mkdirSync(this.p.jobsLog, { recursive: true });
    const file = join(this.p.jobsLog, `${job}-${this.now().toISOString().replace(/[:.]/g, '-')}.log`);
    const status: JobStatus = { job, state: 'running', startedAt: this.now().toISOString(), startedBy: username, lines: [] };
    this.job = status;
    const child = this.spawn(JOBS[job].args, `website (${username})`);
    this.jobChild = child;
    collect(child, status.lines, file);
    child.once('error', (e) => status.lines.push(`Could not start: ${e.message}`));
    child.once('close', (code) => {
      status.state = code === 0 ? 'succeeded' : 'failed';
      status.exitCode = code;
      status.finishedAt = this.now().toISOString();
      this.jobChild = undefined;
    });
    return this.jobStatus()!;
  }

  static jobLabel(job: JobName) {
    return JOBS[job].label;
  }
}
