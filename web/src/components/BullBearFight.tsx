/**
 * Loading animation: the bull (left) and the bear (right) charge and clash in a loop while work is in
 * progress. With `finished`, the bull wins: it knocks the bear away and "BULLS WIN!" appears.
 * Pure decoration: it says nothing about where the market will go.
 */
export function BullBearFight({ finished = false, label, size = 'lg' }: { finished?: boolean; label?: string; size?: 'sm' | 'lg' }) {
  const big = size === 'lg';
  return (
    <div className="flex flex-col items-center py-4" role="status" aria-live="polite">
      <div className={`fight-arena ${finished ? 'is-won' : 'is-fighting'} ${big ? 'h-44 w-[22rem]' : 'h-24 w-56'} relative max-w-full overflow-hidden`}>
        <div className="fight-ground" />
        <img src="/bull.png" alt="" draggable={false} className={`fight-bull ${big ? 'h-28' : 'h-14'}`} />
        <img src="/bear.png" alt="" draggable={false} className={`fight-bear ${big ? 'h-28' : 'h-14'}`} />
        {!finished && (
          <svg viewBox="-20 -20 40 40" className={`fight-spark ${big ? 'h-14 w-14' : 'h-8 w-8'}`} aria-hidden="true">
            <polygon points="0,-18 4,-6 16,-10 7,-1 18,6 5,6 3,18 -3,7 -15,13 -7,1 -17,-8 -4,-5" fill="#ffd34d" stroke="#ff2d78" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        )}
        {finished && <div className={`fight-win led led-up ${big ? 'text-3xl' : 'text-lg'}`}>BULLS WIN!</div>}
      </div>
      {label && <p className="mt-2 max-w-md text-center text-sm text-slate-400">{label}</p>}
      <span className="sr-only">{finished ? 'Done' : 'Loading'}</span>
    </div>
  );
}
