import { useState, type FormEvent } from 'react';
import { errorText, sb, toEmail } from '../lib/supabase';
import { Button, ErrorNote, Field } from '../components/ui';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Enter your username and password.'); return; }
    setBusy(true);
    setError(null);
    const { error: err } = await sb.auth.signInWithPassword({ email: toEmail(username), password });
    setBusy(false);
    if (err) setError(/invalid/i.test(err.message) ? 'That username and password don’t match.' : errorText(err));
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-13 items-center gap-2.5 bg-navy px-5 py-3.5 font-semibold text-white">
        <span className="grid h-6 w-6 place-items-center rounded bg-teal text-xs font-bold" aria-hidden="true">P</span>
        Pick your inventory
      </header>
      <main className="grid flex-1 place-items-center px-4 py-8">
        <form onSubmit={submit} noValidate className="w-full max-w-sm rounded-lg border border-line bg-white p-6">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mb-5 text-sm text-muted">Use the username and password your manager gave you.</p>
          <ErrorNote error={error} />
          <div className="flex flex-col gap-3">
            <Field label="Username">
              <input className="input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
                value={username} onChange={e => setUsername(e.target.value)} autoFocus />
            </Field>
            <Field label="Password">
              <input className="input" name="password" type="password" autoComplete="current-password"
                value={password} onChange={e => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" busy={busy} className="mt-1 w-full">Sign in</Button>
          </div>
        </form>
      </main>
    </div>
  );
}
