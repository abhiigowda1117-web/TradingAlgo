import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler } from './api';

interface Me {
  user: { username: string };
  csrfToken: string;
  tradingMode?: 'paper' | 'live';
}

interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn';
  username: string | null;
  tradingMode: 'paper' | 'live';
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [username, setUsername] = useState<string | null>(null);
  const [tradingMode, setTradingMode] = useState<'paper' | 'live'>('paper');

  const signedOut = useCallback(() => {
    setCsrfToken(null);
    setUsername(null);
    setStatus('signedOut');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(signedOut);
    api<Me>('/api/auth/me')
      .then((me) => {
        setCsrfToken(me.csrfToken);
        setUsername(me.user.username);
        setTradingMode(me.tradingMode ?? 'paper');
        setStatus('signedIn');
      })
      .catch(signedOut);
    return () => setUnauthorizedHandler(null);
  }, [signedOut]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      username,
      tradingMode,
      async login(u, p) {
        const me = await api<Me>('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
        setCsrfToken(me.csrfToken);
        setUsername(me.user.username);
        const full = await api<Me>('/api/auth/me');
        setTradingMode(full.tradingMode ?? 'paper');
        setStatus('signedIn');
      },
      async logout() {
        await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
        signedOut();
      },
    }),
    [status, username, tradingMode, signedOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
