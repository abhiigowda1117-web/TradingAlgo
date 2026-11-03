import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '../lib/auth';

export function Login() {
  const { status, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'signedIn') return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <span className="text-2xl font-semibold text-slate-100">AlgoTrade</span>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <h1 className="text-lg font-semibold">Sign in</h1>
            <p className="text-sm text-slate-400">Private research and paper-trading dashboard.</p>
          </div>
          {error && <p className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down" role="alert">{error}</p>}
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Username</span>
            <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={32} autoFocus />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Password</span>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={200} />
          </label>
          <button className="btn w-full" disabled={busy || status === 'loading'}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
