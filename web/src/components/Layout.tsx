import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import type { MarketMovers, MarketOverview } from '../lib/types';
import { useApi } from '../lib/useApi';
import { Bear, Bull, marketMood } from './BullBear';
import { Icon } from './icons';
import { MarketPulse } from './MarketPulse';
import { Badge } from './ui';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/research', label: 'Company Research', icon: 'research' },
  { to: '/watchlist', label: 'Market Watchlist', icon: 'watchlist' },
  { to: '/engine', label: 'Trading Engine', icon: 'engine' },
  { to: '/portfolio', label: 'Paper Portfolio', icon: 'portfolio' },
  { to: '/backtest', label: 'Backtesting', icon: 'backtest' },
  { to: '/risk', label: 'Risk Management', icon: 'risk' },
  { to: '/trades', label: 'Trade History', icon: 'trades' },
  { to: '/reports', label: 'Reports', icon: 'reports' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
] as const;

type Pulse = { market: MarketOverview | null; movers: MarketMovers | null };

function Sidebar({ onNavigate, pulse }: { onNavigate?: () => void; pulse: Pulse }) {
  return (
    <nav className="thin-scroll flex h-full flex-col gap-0.5 overflow-y-auto p-3" aria-label="Main">
      <div className="mb-3 flex items-center gap-2 px-2 pt-1">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <span className="bg-gradient-to-r from-accent to-rose bg-clip-text text-lg font-bold tracking-wide text-transparent">AlgoTrade</span>
      </div>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg border-l-2 px-3 py-1.5 text-sm transition ${isActive ? 'border-rose bg-gradient-to-r from-accent/20 to-transparent font-medium text-white shadow-[inset_0_0_12px_rgba(47,125,255,0.15)]' : 'border-transparent text-slate-400 hover:bg-ink-850 hover:text-slate-200'}`
          }
        >
          <Icon name={n.icon} className="h-4 w-4" />
          {n.label}
        </NavLink>
      ))}
      <MarketPulse market={pulse.market} movers={pulse.movers} />
    </nav>
  );
}

export function Layout() {
  const { username, tradingMode, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const market = useApi<MarketOverview>('/api/market/overview', 120_000);
  const movers = useApi<MarketMovers>('/api/market/movers', 120_000);
  const pulse: Pulse = { market: market.data, movers: movers.data };
  const nifty = market.data?.indices.find((i) => i.ticker === '^NSEI')?.changePct ?? null;
  const mood = marketMood(nifty);
  const moodText = nifty === null ? '' : ` (NIFTY 50 ${nifty >= 0 ? '+' : ''}${nifty.toFixed(2)}% today)`;
  const title = NAV.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)))?.label ?? 'AlgoTrade';

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-ink-800 bg-ink-900/95 lg:block">
        <Sidebar pulse={pulse} />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button className="absolute inset-0 bg-black/60" aria-label="Close menu" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-ink-800 bg-ink-900">
            <Sidebar pulse={pulse} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-ink-800 bg-black/85 px-3 shadow-[0_1px_0_rgba(255,45,120,0.15)] backdrop-blur sm:gap-3 sm:px-4">
          <Bull mood={mood} title={`Bull${mood === 'bull' ? ': bulls lead today' : ''}${moodText}`} />
          <button className="btn-ghost lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}>
            <Icon name="menu" className="h-4 w-4" />
          </button>
          <span className="truncate text-sm font-medium text-slate-300">{title}</span>
          <div className="ml-auto flex items-center gap-3">
            <Badge color={tradingMode === 'live' ? 'red' : 'blue'}>{tradingMode === 'live' ? 'LIVE MODE CONFIGURED' : 'PAPER'}</Badge>
            <span className="hidden text-sm text-slate-400 sm:inline">{username}</span>
            <button className="btn-ghost" onClick={() => void logout()}>
              <Icon name="logout" className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
            <Bear mood={mood} title={`Bear${mood === 'bear' ? ': bears lead today' : ''}${moodText}`} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
