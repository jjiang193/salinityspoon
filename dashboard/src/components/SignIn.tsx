import { useState, type FormEvent } from 'react';
import { signIn } from '../lib/cloud';

/**
 * The gate in front of a cloud build. A local build never renders this: the
 * demo runs on a laptop with no accounts, and adding a login to it would only
 * be something to fumble on stage.
 *
 * Nothing here is remembered. A reload asks again, because the token it holds
 * opens a patient's record and a clinician's laptop is not a private place.
 */
export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <h1>NaTrack</h1>
        <p className="signin-sub">Sodium monitoring for clinicians and patients</p>

        <label htmlFor="email">Email</label>
        <input
          id="email" type="email" autoComplete="username" required
          value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password" type="password" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
        />

        {error && <p className="signin-error" role="alert">{error}</p>}

        <button type="submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="signin-note">
          Demo data only. Every patient here is invented.
        </p>
      </form>
    </div>
  );
}
