'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { fmtClock, fmtSize, zonedToISO } from '@/lib/format';
import { Icon } from './Icon';

/* ---------------- toasts ---------------- */
type ToastKind = '' | 'error' | 'warn';
export function toast(msg: string, kind: ToastKind = '') {
  window.dispatchEvent(new CustomEvent('hl-toast', { detail: { msg, kind } }));
}
export function Toaster() {
  const [items, setItems] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, ...d }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), d.kind ? 7000 : 3500);
    };
    window.addEventListener('hl-toast', on);
    return () => window.removeEventListener('hl-toast', on);
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          <Icon name={t.kind ? 'alert' : 'check'} />
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- server calls ---------------- */
const clean = (m: string) => m.replace(/^.*?ERROR:\s*/, '').trim();

export function useRpc() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (fn: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    const { data, error } = await createClient().rpc(fn, args);
    setBusy(false);
    if (error) {
      setError(clean(error.message));
      return { ok: false as const, error: clean(error.message) };
    }
    router.refresh();
    return { ok: true as const, data };
  }, [router]);
  return { run, busy, error, setError };
}

export const MAX_FILE = 10 * 1024 * 1024;
export async function uploadFiles(taskId: number, files: File[], link: { comment?: number | null; submission?: number | null } = {}) {
  const sb = createClient();
  const failed: string[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE) { failed.push(f.name + ' (over 10 MB)'); continue; }
    const safe = f.name.replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';
    const path = `${taskId}/${crypto.randomUUID()}-${safe}`;
    const up = await sb.storage.from('task-files').upload(path, f, { contentType: f.type || undefined, upsert: false });
    if (up.error) { failed.push(f.name); continue; }
    const reg = await sb.rpc('register_attachment', {
      p_task: taskId, p_path: path, p_name: f.name, p_size: f.size, p_mime: f.type || null,
      p_comment: link.comment ?? null, p_submission: link.submission ?? null,
    });
    if (reg.error) failed.push(f.name);
  }
  if (failed.length) toast('Some files could not be uploaded: ' + failed.join(', '), 'error');
}

/* ---------------- modal ---------------- */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const id = useId();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} style={wide ? { width: 'min(720px,100%)' } : undefined}>
        <div className="modal-h">
          <h2 id={id}>{title}</h2>
          <button className="btn ghost sm" type="button" onClick={onClose}><Icon name="x" />Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------------- generic action dialog ---------------- */
export type Field = {
  name: string; label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'time' | 'select' | 'checks' | 'radio' | 'checkbox' | 'files' | 'url';
  options?: [string, string][]; required?: boolean; min?: number | string; max?: number | string; step?: number;
  defaultValue?: string | number; placeholder?: string; hint?: string; minLength?: number;
  showIf?: { field: string; equals: string };
};
export type ArgSpec = string | number | boolean | null | {
  field: string; as?: 'number' | 'text' | 'bool' | 'intArray' | 'lines' | 'links' | 'datetime'; time?: string;
};

function valueOf(spec: ArgSpec, v: Record<string, unknown>, tz: string): unknown {
  if (spec === null || typeof spec !== 'object') return spec;
  const raw = v[spec.field];
  switch (spec.as) {
    case 'number': return raw === '' || raw == null ? null : Number(raw);
    case 'bool': return raw === true || raw === 'true' || raw === 'on';
    case 'intArray': return (raw as string[] | undefined ?? []).map(Number);
    case 'lines': return String(raw ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    case 'links': return String(raw ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map((l) => {
      const p = l.split('|'); const url = (p[1] ?? p[0]).trim(); return { label: (p[1] ? p[0] : url).trim(), url };
    });
    case 'datetime': return raw && v[spec.time!] ? zonedToISO(String(raw), String(v[spec.time!]), tz) : null;
    default: return raw == null ? '' : String(raw).trim();
  }
}

export function FieldInput({ f, id, value, onChange }: { f: Field; id: string; value: unknown; onChange: (v: unknown) => void }) {
  const t = f.type ?? 'text';
  if (t === 'textarea') return <textarea id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} required={f.required} minLength={f.minLength} />;
  if (t === 'select') return (
    <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
      {f.options?.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  if (t === 'checks' || t === 'radio') {
    const arr = (value as string[]) ?? [];
    return (
      <div className="checks" role="group" aria-labelledby={id + '-l'}>
        {f.options?.map(([v, l]) => (
          <label key={v}>
            <input type={t === 'checks' ? 'checkbox' : 'radio'} name={id} value={v}
              checked={t === 'checks' ? arr.includes(v) : value === v}
              onChange={(e) => onChange(t === 'checks' ? (e.target.checked ? [...arr, v] : arr.filter((x) => x !== v)) : v)} />
            <span>{l}</span>
          </label>
        ))}
      </div>
    );
  }
  if (t === 'checkbox') return <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />{f.hint}</label>;
  if (t === 'files') return <FilePicker id={id} files={(value as File[]) ?? []} onChange={onChange} />;
  return <input id={id} type={t} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder}
    required={f.required} min={f.min} max={f.max} step={f.step ?? (t === 'number' ? 0.25 : undefined)} minLength={f.minLength} />;
}

export function FilePicker({ id, files, onChange }: { id: string; files: File[]; onChange: (f: File[]) => void }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : ''));
    setUrls(u);
    return () => u.forEach((x) => x && URL.revokeObjectURL(x));
  }, [files]);
  return (
    <>
      <input id={id} type="file" multiple onChange={(e) => onChange([...(e.target.files ?? [])])} />
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f, i) => (
            <li key={i}>
              {urls[i] ? <img src={urls[i]} alt="" /> : <span className="fi"><Icon name="clip" /></span>}
              <span>{f.name}</span>
              <span className="faint" style={{ flex: 'none' }}>
                {fmtSize(f.size)}{f.size > MAX_FILE && <> · <b style={{ color: 'var(--bad)' }}>too large</b></>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <small className="muted">Images, PDFs, documents and more, up to 10 MB each. Stored privately; only people on this task can open them.</small>
    </>
  );
}

export function RpcDialog(props: {
  label: string; icon?: string; variant?: string; small?: boolean; title: string; intro?: React.ReactNode;
  fields: Field[]; fn: string; args: Record<string, ArgSpec>; submitLabel: string; danger?: boolean;
  success?: string; tz?: string; files?: { field: string; task: number; link?: 'comment' | 'submission' };
  redirectTo?: string; validate?: { field: string; allOf?: number; message: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn ${props.variant ?? ''} ${props.small ? 'sm' : ''}`} onClick={() => setOpen(true)}>
        {props.icon && <Icon name={props.icon} />}{props.label}
      </button>
      {open && <DialogBody {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function DialogBody(props: React.ComponentProps<typeof RpcDialog> & { onClose: () => void }) {
  const init: Record<string, unknown> = {};
  props.fields.forEach((f) => { init[f.name] = f.type === 'checks' ? [] : f.type === 'files' ? [] : f.defaultValue ?? (f.type === 'radio' ? f.options?.[0]?.[0] : ''); });
  const [v, setV] = useState(init);
  const { run, busy, error, setError } = useRpc();
  const router = useRouter();
  const base = useId();
  const firstRef = useRef<HTMLFormElement>(null);
  useEffect(() => { firstRef.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]),textarea,select')?.focus(); }, []);
  const visible = (f: Field) => !f.showIf || String(v[f.showIf.field]) === f.showIf.equals;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    for (const f of props.fields.filter(visible)) {
      const val = v[f.name];
      if (f.required && (val === '' || val == null)) return setError(`${f.label} is required.`);
      if (f.minLength && String(val ?? '').trim().length < f.minLength) return setError(`${f.label}: write at least ${f.minLength} characters.`);
    }
    for (const c of props.validate ?? []) {
      if (c.allOf != null && ((v[c.field] as unknown[]) ?? []).length < c.allOf) return setError(c.message);
    }
    if (props.files && ((v[props.files.field] as File[]) ?? []).some((f) => f.size > MAX_FILE)) return setError('Each file must be 10 MB or smaller.');
    const args: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(props.args)) args[k] = valueOf(spec, v, props.tz ?? 'UTC');
    const r = await run(props.fn, args);
    if (!r.ok) return;
    if (props.files) {
      const files = (v[props.files.field] as File[]) ?? [];
      if (files.length) {
        const id = typeof r.data === 'number' ? r.data : null;
        await uploadFiles(props.files.task, files, props.files.link ? { [props.files.link]: id } : {});
        router.refresh();
      }
    }
    props.onClose();
    if (props.success) toast(props.success);
    if (props.redirectTo) router.push(props.redirectTo);
  }

  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form onSubmit={submit} ref={firstRef}>
        {props.intro}
        {props.fields.filter(visible).map((f) => {
          const id = base + f.name;
          if (f.type === 'checkbox') return <FieldInput key={f.name} f={f} id={id} value={v[f.name]} onChange={(x) => setV({ ...v, [f.name]: x })} />;
          return (
            <div className="fld" key={f.name}>
              <label htmlFor={id} id={id + '-l'} style={{ fontSize: 12.5, fontWeight: 600 }}>{f.label}</label>
              <FieldInput f={f} id={id} value={v[f.name]} onChange={(x) => setV({ ...v, [f.name]: x })} />
              {f.hint && <small>{f.hint}</small>}
            </div>
          );
        })}
        {error && <p className="form-err" role="alert">{error}</p>}
        <div className="modal-f">
          <button type="button" className="btn ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" className={'btn ' + (props.danger ? 'danger' : 'primary')} disabled={busy}>
            {busy && <span className="spinner" />}{props.submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* One-click action, with an optional confirmation step. */
export function RpcButton({ fn, args, label, icon, variant = '', small, success, confirm, redirectTo }: {
  fn: string; args: Record<string, unknown>; label: string; icon?: string; variant?: string; small?: boolean;
  success?: string; confirm?: { title: string; body: string; action: string }; redirectTo?: string;
}) {
  const { run, busy } = useRpc();
  const router = useRouter();
  const [ask, setAsk] = useState(false);
  async function go() {
    const r = await run(fn, args);
    setAsk(false);
    if (!r.ok) return toast(r.error, 'error');
    if (success) toast(success);
    if (redirectTo) router.push(redirectTo);
  }
  return (
    <>
      <button type="button" className={`btn ${variant} ${small ? 'sm' : ''}`} disabled={busy} onClick={() => (confirm ? setAsk(true) : go())}>
        {busy ? <span className="spinner" /> : icon && <Icon name={icon} />}{label}
      </button>
      {ask && confirm && (
        <Modal title={confirm.title} onClose={() => setAsk(false)}>
          <div className="modal-b">
            <p>{confirm.body}</p>
            <div className="modal-f">
              <button className="btn ghost" onClick={() => setAsk(false)}>Cancel</button>
              <button className="btn primary" onClick={go} disabled={busy}>{confirm.action}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ---------------- timers ---------------- */
export function Clock({ since }: { since: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  return <span className="num">{now == null ? '··:··:··' : fmtClock(now - new Date(since).getTime())}</span>;
}

/** Keeps timers honest: asks the server every minute to stop any timer at its limit. */
export function TimerSync({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const i = setInterval(async () => {
      const { data } = await createClient().rpc('sync_timers');
      if (Number(data) > 0) router.refresh();
    }, 60000);
    const vis = () => document.visibilityState === 'visible' && router.refresh();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(i); document.removeEventListener('visibilitychange', vis); };
  }, [active, router]);
  return null;
}

/* ---------------- navigation ---------------- */
export function NavLinks({ items }: { items: { href: string; label: string; icon: string; count?: number }[] }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {items.map((i) => {
        const active = i.href === '/' ? path === '/' : path === i.href || path.startsWith(i.href + '/');
        return (
          <Link key={i.href} href={i.href} aria-current={active ? 'page' : undefined}>
            <Icon name={i.icon} /><span>{i.label}</span>
            {!!i.count && <span className="count">{i.count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

/* Navigates when a filter select changes (keeps other query params). */
export function FilterSelect({ name, value, options, label }: { name: string; value: string; options: [string, string][]; label: string }) {
  const router = useRouter();
  const path = usePathname();
  return (
    <select aria-label={label} value={value} onChange={(e) => {
      const q = new URLSearchParams(window.location.search);
      if (e.target.value) q.set(name, e.target.value); else q.delete(name);
      router.push(path + (q.toString() ? '?' + q : ''));
    }}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function SearchBox({ value }: { value: string }) {
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams(window.location.search);
      if (q) p.set('q', q); else p.delete('q');
      if ((p.get('q') ?? '') !== value) router.replace(path + (p.toString() ? '?' + p : ''));
    }, 300);
    return () => clearTimeout(t);
  }, [q, value, path, router]);
  return <input type="search" placeholder="Search tasks" aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />;
}
