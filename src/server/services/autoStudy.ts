import { hhmm, istParts } from '../../util/time';

/**
 * Automatic daily analysis: on every trading day (Mon-Fri, not an NSE holiday) from `at` IST, runs the
 * company study once so the engine always has a fresh watchlist for its 15:10 check. If the study
 * fails (e.g. Yahoo refuses requests), it tries again after `retryMinutes`, at most `maxAttempts`
 * times a day. Never overlaps another job; read-only analysis, it never places orders.
 */
export interface AutoStudyDeps {
  now: () => Date;
  /** IST date (YYYY-MM-DD) of the current watchlist, or null if there is none. */
  watchlistDate: () => string | null;
  jobRunning: () => boolean;
  /** Starts the study job. */
  run: () => void;
  holidays: string[];
  at?: string;
  maxAttempts?: number;
  retryMinutes?: number;
}

export interface AutoStudyStatus {
  enabled: true;
  at: string;
  lastStartedAt?: string;
  attemptsToday: number;
  note: string;
}

export class AutoStudy {
  private day = '';
  private attempts = 0;
  private lastAttempt = 0;
  private lastStartedAt?: string;
  private note = 'Waiting for the next trading day.';

  constructor(private d: AutoStudyDeps) {}

  private get at() {
    return this.d.at ?? '08:45';
  }

  /** Called every minute. Returns true when it started the study. */
  tick(): boolean {
    const now = this.d.now();
    const t = istParts(now);
    if (t.weekday === 0 || t.weekday === 6 || this.d.holidays.includes(t.date)) {
      this.note = 'No market today; the next automatic refresh is on the next trading day.';
      return false;
    }
    if (t.minutes < hhmm(this.at)) {
      this.note = `Today's automatic refresh starts at ${this.at} IST.`;
      return false;
    }
    if (this.d.watchlistDate() === t.date) {
      this.note = 'The watchlist is already up to date for today.';
      return false;
    }
    if (this.day !== t.date) {
      this.day = t.date;
      this.attempts = 0;
      this.lastAttempt = 0;
    }
    const max = this.d.maxAttempts ?? 3;
    if (this.attempts >= max) {
      this.note = `The automatic refresh failed ${max} times today (the data source may be refusing requests). Press "Refresh watchlist now" to try again.`;
      return false;
    }
    if (this.lastAttempt && now.getTime() - this.lastAttempt < (this.d.retryMinutes ?? 60) * 60_000) return false;
    if (this.d.jobRunning()) return false;
    this.attempts++;
    this.lastAttempt = now.getTime();
    this.lastStartedAt = now.toISOString();
    this.note = 'Refreshing the watchlist automatically now.';
    this.d.run();
    return true;
  }

  status(): AutoStudyStatus {
    return { enabled: true, at: this.at, attemptsToday: this.attempts, note: this.note, ...(this.lastStartedAt ? { lastStartedAt: this.lastStartedAt } : {}) };
  }
}
