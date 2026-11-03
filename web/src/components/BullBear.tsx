/**
 * Bull (top left) and bear (top right) images in the header. The one that matches today's NIFTY 50
 * move gets a soft glow. Decoration only: it describes today's move, it does not predict.
 */

type Mood = 'bull' | 'bear' | 'flat' | null;

export function marketMood(niftyChangePct: number | null | undefined): Mood {
  if (niftyChangePct === null || niftyChangePct === undefined || !Number.isFinite(niftyChangePct)) return null;
  if (niftyChangePct > 0.05) return 'bull';
  if (niftyChangePct < -0.05) return 'bear';
  return 'flat';
}

function Mascot({ src, glow, active, title }: { src: string; glow: string; active: boolean; title: string }) {
  return (
    <img
      src={src}
      alt={title}
      title={title}
      draggable={false}
      className={`h-11 w-auto shrink-0 select-none transition duration-500 ${active ? `mascot-glow ${glow}` : ''}`}
    />
  );
}

export const Bear = ({ mood, title }: { mood: Mood; title: string }) => <Mascot src="/bear.png" glow="mascot-bear" active={mood === 'bear'} title={title} />;
export const Bull = ({ mood, title }: { mood: Mood; title: string }) => <Mascot src="/bull.png" glow="mascot-bull" active={mood === 'bull'} title={title} />;
