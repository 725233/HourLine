'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    const site = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin;
    const { error } = await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: site + '/auth/callback' },
    });
    setBusy(false);
    // Don't reveal whether an address has an account.
    if (error && !/signups not allowed|not found/i.test(error.message)) setErr(error.message);
    else setSent(true);
  }
  if (sent) return <p className="note ok">If <b>&nbsp;{email}&nbsp;</b> has an account, a sign-in link is on its way. Open it on this device.</p>;
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label className="fld"><span>Work email</span>
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {err && <p className="form-err" role="alert">{err}</p>}
      <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
    </form>
  );
}
