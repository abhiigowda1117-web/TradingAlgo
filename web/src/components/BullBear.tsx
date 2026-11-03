/**
 * Neon line-art bull (left, blue) and bear (right, rose) for the header. The one that matches today's
 * NIFTY 50 move glows; the other dims. Decoration only: it describes today's move, it does not predict.
 */

type Mood = 'bull' | 'bear' | 'flat' | null;

export function marketMood(niftyChangePct: number | null | undefined): Mood {
  if (niftyChangePct === null || niftyChangePct === undefined || !Number.isFinite(niftyChangePct)) return null;
  if (niftyChangePct > 0.05) return 'bull';
  if (niftyChangePct < -0.05) return 'bear';
  return 'flat';
}

const look = (me: 'bull' | 'bear', mood: Mood) => (mood === me ? 'neon neon-pulse' : mood === null || mood === 'flat' ? 'neon' : 'neon neon-dim');

export function Bull({ mood, title }: { mood: Mood; title: string }) {
  return (
    <svg viewBox="0 0 64 48" className={`h-9 w-12 shrink-0 text-up ${look('bull', mood)}`} role="img" aria-label={title} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <title>{title}</title>
      {/* horns */}
      <path d="M22 17 C14 16 6 12 4 4 C10 10 16 12 23 12" />
      <path d="M42 17 C50 16 58 12 60 4 C54 10 48 12 41 12" />
      {/* ears */}
      <path d="M22 17 C16 18 12 22 11 24 C16 25 21 23 24 21" />
      <path d="M42 17 C48 18 52 22 53 24 C48 25 43 23 40 21" />
      {/* head */}
      <path d="M23 12 C27 10 37 10 41 12 C43 18 42 26 40 32 C39 38 36 44 32 44 C28 44 25 38 24 32 C22 26 21 18 23 12 Z" />
      {/* brow, eyes, snout */}
      <path d="M26 19 L29.5 21 M38 19 L34.5 21" />
      <circle cx="27.5" cy="23.5" r="1.2" fill="currentColor" />
      <circle cx="36.5" cy="23.5" r="1.2" fill="currentColor" />
      <ellipse cx="32" cy="37.5" rx="6" ry="4.5" />
      <circle cx="29.6" cy="37.5" r="0.9" fill="currentColor" />
      <circle cx="34.4" cy="37.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function Bear({ mood, title }: { mood: Mood; title: string }) {
  return (
    <svg viewBox="0 0 64 48" className={`h-9 w-12 shrink-0 text-down ${look('bear', mood)}`} role="img" aria-label={title} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <title>{title}</title>
      {/* ears (drawn first; the head outline crosses their base) */}
      <path d="M15.5 15.5 A6.5 6.5 0 1 1 24 8.5" />
      <path d="M48.5 15.5 A6.5 6.5 0 1 0 40 8.5" />
      <path d="M17.5 12 A2.6 2.6 0 0 1 21 9.2 M46.5 12 A2.6 2.6 0 0 0 43 9.2" />
      {/* head */}
      <path d="M32 7 C45 7 52 16 52 26 C52 37 43 44 32 44 C21 44 12 37 12 26 C12 16 19 7 32 7 Z" />
      {/* angry brows, eyes */}
      <path d="M22 19.5 L28 22 M42 19.5 L36 22" />
      <circle cx="26" cy="25" r="1.3" fill="currentColor" />
      <circle cx="38" cy="25" r="1.3" fill="currentColor" />
      {/* muzzle, nose, mouth */}
      <ellipse cx="32" cy="34" rx="8.5" ry="6.5" />
      <path d="M29 30.5 H35 L32 33.5 Z" fill="currentColor" />
      <path d="M32 33.5 V36 M28.5 37.5 Q32 39.5 35.5 37.5" />
    </svg>
  );
}
