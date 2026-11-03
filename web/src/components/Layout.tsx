import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { Icon } from './icons';
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

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label="Main">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <span className="text-lg font-semibold text-slate-100">AlgoTrade</span>
      </div>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-ink-800 font-medium text-slate-100' : 'text-slate-400 hover:bg-ink-850 hover:text-slate-200'}`
          }
        >
          <Icon name={n.icon} className="h-4 w-4" />
          {n.label}
        </NavLink>
      ))}
      <p className="mt-auto px-3 pt-4 text-xs leading-relaxed text-slate-600">Private dashboard. Paper trading only. Not investment advice.</p>
    </nav>
  );
}

export function Layout() {
  const { username, tradingMode, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const title = NAV.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)))?.label ?? 'AlgoTrade';

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-ink-800 bg-ink-900 lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button className="absolute inset-0 bg-black/60" aria-label="Close menu" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-ink-800 bg-ink-900">
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-ink-800 bg-ink-950/90 px-4 backdrop-blur">
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
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
