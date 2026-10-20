import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="login-wrap">
      <div className="login">
        <h1>Not found</h1>
        <p className="muted">This page doesn’t exist, or you don’t have access to it.</p>
        <Link className="btn primary" href="/" style={{ justifyContent: 'center' }}>Go to dashboard</Link>
      </div>
    </div>
  );
}
