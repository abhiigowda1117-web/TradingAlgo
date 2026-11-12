import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

interface SetupState {
  needsAccount: boolean;
  canCreateHere: boolean;
  /** Hosting server: the first account needs the SETUP_CODE chosen at install time. */
  needsSetupCode?: boolean;
}

/** First start: create the owner account in the browser (only on the computer that runs AlgoTrade). */
function CreateAccount({ canCreateHere, needsSetupCode }: { canCreateHere: boolean; needsSetupCode?: boolean }) {
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!canCreateHere) {
    return (
      <div className="card space-y-2 p-6 text-sm">
        <h1 className="text-lg font-semibold">Welcome to AlgoTrade</h1>
        <p className="text-slate-300">No account has been created yet.</p>
        <p className="text-slate-400">
          For safety, the first account can only be created on the computer that runs AlgoTrade. On that computer, open <b className="text-slate-200">http://localhost:3001</b>.
        </p>
      </div>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) return setError('The two passwords are different.');
    setBusy(true);
    setError(null);
    try {
      await api('/api/setup/account', { method: 'POST', body: needsSetupCode ? { username, password, setupCode } : { username, password } });
      window.location.assign('/'); // signed in by the server; reload into the dashboard
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Create your account</h1>
        <p className="text-sm text-slate-400">{needsSetupCode ? 'First start of this server.' : 'First start on this computer.'} This account has full control; you can add view-only accounts for others later.</p>
      </div>
      {needsSetupCode && (
        <label className="block text-sm">
          <span className="mb-1 block text-slate-400">Setup code (the SETUP_CODE you chose when installing the server)</span>
          <input className="input" type="password" autoComplete="off" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} required minLength={12} maxLength={200} />
        </label>
      )}
      {error && <p className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down" role="alert">{error}</p>}
      <label className="block text-sm">
        <span className="mb-1 block text-slate-400">Username (3 to 32 characters: letters, digits, _ . -)</span>
        <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} required minLength={3} maxLength={32} pattern="[a-z0-9_.\-]{3,32}" autoFocus />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-400">Password (at least 10 characters)</span>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} maxLength={200} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-400">Repeat password</span>
        <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required minLength={10} maxLength={200} />
      </label>
      <button className="btn w-full" disabled={busy}>{busy ? 'Creating…' : 'Create account and sign in'}</button>
    </form>
  );
}

export function Login() {
  const { status, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<SetupState | null>(null);
  useEffect(() => {
    api<SetupState>('/api/setup').then(setSetup, () => setSetup(null));
  }, []);

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
        {setup?.needsAccount ? <CreateAccount canCreateHere={setup.canCreateHere} needsSetupCode={setup.needsSetupCode} /> : (
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
        )}
      </div>
    </div>
  );
}
