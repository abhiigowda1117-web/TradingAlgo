const IST = 'Asia/Kolkata';

export interface IstParts {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since midnight IST
  weekday: number; // 0 = Sunday
}

export function istParts(now: Date = new Date()): IstParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: weekdays.indexOf(p.weekday ?? ''),
  };
}

/** "HH:MM" -> minutes since midnight. */
export function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) throw new Error(`Bad time "${s}", expected HH:MM`);
  return h * 60 + m;
}

export const NSE_OPEN = hhmm('09:15');
export const NSE_CLOSE = hhmm('15:30');

export function isNseOpen(now: Date, holidays: string[]): boolean {
  const t = istParts(now);
  if (t.weekday === 0 || t.weekday === 6) return false;
  if (holidays.includes(t.date)) return false;
  return t.minutes >= NSE_OPEN && t.minutes < NSE_CLOSE;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 86_400_000;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
