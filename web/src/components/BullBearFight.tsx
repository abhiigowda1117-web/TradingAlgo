/**
 * Loading animation: the bull (left) and the bear (right) charge and clash in a loop while work is in
 * progress. With `finished`, the bull wins: it charges once more and knocks the bear away. Motion only.
 * Pure decoration: it says nothing about where the market will go.
 */
export function BullBearFight({ finished = false, label, size = 'lg' }: { finished?: boolean; label?: string; size?: 'sm' | 'lg' }) {
  const big = size === 'lg';
  return (
    <div className="flex flex-col items-center py-4" role="status" aria-live="polite">
      <div className={`fight-arena ${finished ? 'is-won' : 'is-fighting'} ${big ? 'h-32 w-[22rem]' : 'h-16 w-56'} relative max-w-full overflow-hidden`}>
        <img src="/bull-solo.png" alt="" draggable={false} className={`fight-bull ${big ? 'h-24' : 'h-12'}`} />
        <img src="/bear-solo.png" alt="" draggable={false} className={`fight-bear ${big ? 'h-24' : 'h-12'}`} />
      </div>
      {label && <p className="mt-2 max-w-md text-center text-sm text-slate-400">{label}</p>}
      <span className="sr-only">{finished ? 'Done' : 'Loading'}</span>
    </div>
  );
}

/**
 * Dashboard strip: the bull and bear (animals only) charge and clash, step back, cross each other at
 * the same level (the bear in the back lane, the bull in front) to swap places, turn around, and repeat.
 */
export function BullBearArena() {
  return (
    <section className="arena card overflow-hidden !p-0" aria-label="Bull and bear animation">
      <div className="arena-floor" />
      <div className="arena-runner arena-bear">
        <span className="arena-shadow" />
        <img src="/bear-solo.png" alt="" draggable={false} />
      </div>
      <div className="arena-runner arena-bull">
        <span className="arena-shadow" />
        <img src="/bull-solo.png" alt="" draggable={false} />
      </div>
      <span className="arena-dust d1" />
      <span className="arena-dust d2" />
      <span className="arena-dust d3" />
    </section>
  );
}
