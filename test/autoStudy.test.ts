import { describe, expect, it } from 'vitest';
import { AutoStudy } from '../src/server/services/autoStudy';

const IST = (s: string) => new Date(`${s}+05:30`);

function setup(o: { watchlist?: string | null; running?: boolean; holidays?: string[] } = {}) {
  let now = IST('2026-11-13T08:00:00'); // Friday
  let wl: string | null = o.watchlist ?? '2026-11-12';
  let running = o.running ?? false;
  const runs: string[] = [];
  const a = new AutoStudy({
    now: () => now,
    watchlistDate: () => wl,
    jobRunning: () => running,
    run: () => {
      runs.push(now.toISOString());
      running = true;
    },
    holidays: o.holidays ?? [],
  });
  return {
    a,
    runs,
    at: (s: string) => (now = IST(s)),
    finish: (ok: boolean) => {
      running = false;
      if (ok) wl = '2026-11-13';
    },
  };
}

describe('automatic daily analysis', () => {
  it('runs once on a trading day from 08:45 IST, then not again that day', () => {
    const s = setup();
    expect(s.a.tick()).toBe(false); // 08:00: too early
    expect(s.a.status().note).toMatch(/08:45/);
    s.at('2026-11-13T08:45:00');
    expect(s.a.tick()).toBe(true);
    expect(s.a.tick()).toBe(false); // job still running
    s.finish(true);
    s.at('2026-11-13T12:00:00');
    expect(s.a.tick()).toBe(false); // watchlist already from today
    expect(s.a.status().note).toMatch(/up to date/);
    expect(s.runs).toHaveLength(1);
  });

  it('a computer switched on at 14:00 refreshes straight away, in time for the 15:10 check', () => {
    const s = setup({ watchlist: null });
    s.at('2026-11-13T14:00:00');
    expect(s.a.tick()).toBe(true);
  });

  it('never on weekends or NSE holidays', () => {
    const s = setup({ holidays: ['2026-11-13'] });
    s.at('2026-11-13T10:00:00');
    expect(s.a.tick()).toBe(false);
    s.at('2026-11-14T10:00:00'); // Saturday
    expect(s.a.tick()).toBe(false);
    expect(s.runs).toHaveLength(0);
  });

  it('after a failed study it retries an hour later, at most 3 times a day; a new day starts again', () => {
    const s = setup();
    s.at('2026-11-13T09:00:00');
    expect(s.a.tick()).toBe(true);
    s.finish(false);
    s.at('2026-11-13T09:30:00');
    expect(s.a.tick()).toBe(false); // too soon
    s.at('2026-11-13T10:00:00');
    expect(s.a.tick()).toBe(true);
    s.finish(false);
    s.at('2026-11-13T11:00:00');
    expect(s.a.tick()).toBe(true);
    s.finish(false);
    s.at('2026-11-13T13:00:00');
    expect(s.a.tick()).toBe(false);
    expect(s.a.status()).toMatchObject({ attemptsToday: 3, note: expect.stringMatching(/failed 3 times/) });
    s.at('2026-11-16T09:00:00'); // Monday
    expect(s.a.tick()).toBe(true);
  });

  it('does not start while another job (e.g. a backtest) is running', () => {
    const s = setup({ running: true });
    s.at('2026-11-13T09:00:00');
    expect(s.a.tick()).toBe(false);
    expect(s.runs).toHaveLength(0);
  });
});

describe('style change', () => {
  it('rebuilds today\'s watchlist when the stock-picking style changed', () => {
    let style = 'balanced';
    const runs: number[] = [];
    const a = new AutoStudy({
      now: () => new Date('2026-11-16T10:00:00+05:30'),
      watchlistDate: () => '2026-11-16',
      watchlistProfile: () => null, // built before styles existed = balanced
      activeProfile: () => style,
      jobRunning: () => false,
      run: () => runs.push(1),
      holidays: [],
    });
    expect(a.tick()).toBe(false);
    style = 'buffett';
    expect(a.tick()).toBe(true);
  });
});
