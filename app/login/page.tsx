import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ inactive?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="login-wrap">
      <div className="login">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark" style={{ color: '#fff', display: 'grid', placeItems: 'center', borderRadius: 9 }}>
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9 2h6" /></svg>
          </div>
          <div><b style={{ color: 'var(--ink)', fontSize: 16 }}>Hourline</b><small style={{ color: 'var(--muted)', display: 'block' }}>Tasks, time and pay</small></div>
        </div>
        <h1>Sign in</h1>
        {sp.inactive && <p className="note bad">Your account is inactive. Ask your manager to reactivate it.</p>}
        {sp.error && <p className="note bad">That sign-in link is invalid or expired. Request a new one below.</p>}
        <LoginForm />
        <p className="small muted">Hourline is invite-only. If you don’t have an account, ask your manager to invite you.</p>
      </div>
    </div>
  );
}
