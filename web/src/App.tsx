import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
import { Backtest } from './pages/Backtest';
import { Dashboard } from './pages/Dashboard';
import { Engine } from './pages/Engine';
import { Login } from './pages/Login';
import { NotFound, Reports, Risk } from './pages/Placeholders';
import { Research } from './pages/Research';
import { Portfolio } from './pages/Portfolio';
import { Settings } from './pages/Settings';
import { Trades } from './pages/Trades';
import { Watchlist } from './pages/Watchlist';

/** Everything except /login requires a signed-in owner. */
function Protected() {
  const { status } = useAuth();
  if (status === 'loading') return <Loading label="Checking your session…" />;
  if (status === 'signedOut') return <Navigate to="/login" replace />;
  return <Layout />;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/research" element={<Research />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/engine" element={<Engine />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/backtest" element={<Backtest />} />
            <Route path="/risk" element={<Risk />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
