'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CURRENCIES } from '@/lib/format';
import { Modal, toast } from './client';
import { Icon } from './Icon';

export function InviteButton() {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ email: '', fullName: '', title: '', role: 'worker', rate: '', currency: 'USD' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const router = useRouter();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    const res = await fetch('/api/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setErr(j.error ?? 'Could not send the invite.');
    setOpen(false);
    setV({ email: '', fullName: '', title: '', role: 'worker', rate: '', currency: 'USD' });
    toast(`Invite sent to ${v.email}.`);
    router.refresh();
  }
  return (
    <>
      <button className="btn primary sm" type="button" onClick={() => setOpen(true)}><Icon name="plus" />Invite person</button>
      {open && (
        <Modal title="Invite a person" onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            <label className="fld"><span>Full name</span><input value={v.fullName} onChange={set('fullName')} required /></label>
            <label className="fld"><span>Work email</span><input type="email" value={v.email} onChange={set('email')} required /></label>
            <div className="row2">
              <label className="fld"><span>Role or title</span><input value={v.title} onChange={set('title')} placeholder="For example: Content writer" /></label>
              <label className="fld"><span>Access</span><select value={v.role} onChange={set('role')}><option value="worker">Worker</option><option value="manager">Manager</option></select></label>
            </div>
            {v.role === 'worker' && (
              <div className="row2">
                <label className="fld"><span>Hourly rate</span><input type="number" min="0.5" step="0.5" value={v.rate} onChange={set('rate')} required /></label>
                <label className="fld"><span>Payment currency</span><select value={v.currency} onChange={set('currency')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></label>
              </div>
            )}
            <p className="small muted">They get an email with a sign-in link. Workers only see their own tasks, time, rate and pay.</p>
            {err && <p className="form-err" role="alert">{err}</p>}
            <div className="modal-f">
              <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn primary" disabled={busy}>{busy && <span className="spinner" />}Send invite</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
