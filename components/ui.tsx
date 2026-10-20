import Link from 'next/link';
import { Icon } from './Icon';
import { PRIORITY_LABEL, STATUS_CLASS, STATUS_LABEL, code, fmtH } from '@/lib/format';
import type { Entry, Hours, Priority, Task, TaskStatus } from '@/lib/types';

export const StatusPill = ({ s }: { s: TaskStatus }) => <span className={'pill ' + STATUS_CLASS[s]}>{STATUS_LABEL[s]}</span>;

export const Prio = ({ p }: { p: Priority }) => (
  <span className={'prio ' + PRIORITY_LABEL[p]}><i />{PRIORITY_LABEL[p]}</span>
);

export function EntryPill({ e }: { e: Pick<Entry, 'status' | 'superseded_by'> }) {
  if (e.superseded_by) return <span className="pill e-replaced">Replaced by #{e.superseded_by}</span>;
  if (e.status === 'pending') return <span className="pill e-pending">Pending approval</span>;
  if (e.status === 'approved') return <span className="pill e-approved">Approved</span>;
  return <span className="pill e-rejected">Rejected</span>;
}

export function KindTag({ e }: { e: Pick<Entry, 'kind' | 'corrects_id'> }) {
  if (e.kind === 'manual') return <span className="tag">Manual</span>;
  if (e.kind === 'correction') return <span className="tag">Correction of #{e.corrects_id}</span>;
  return <span className="tag">Timer</span>;
}

export function Flags({ e }: { e: Pick<Entry, 'flagged' | 'flag_reason' | 'auto_stopped'> }) {
  return (
    <>
      {e.flagged && <span className="flag" title={e.flag_reason}><Icon name="flag" />{e.flag_reason}</span>}
      {e.auto_stopped && <> <span className="flag">Auto-stopped</span></>}
    </>
  );
}

export function Meter({ task, h }: { task: Pick<Task, 'max_hours' | 'status'>; h?: Hours }) {
  const max = Number(task.max_hours);
  if (!(max > 0)) {
    return (
      <div className="meter-l" style={{ fontFamily: 'var(--f-ui)' }}>
        {task.status === 'estimate_submitted' ? 'Estimate waiting for approval' : task.status === 'needs_estimate' ? 'Waiting for worker estimate' : 'No hours approved'}
      </div>
    );
  }
  const used = (h?.logged ?? 0) + (h?.running ?? 0);
  const r = used / max;
  const cls = r >= 1 ? 'over' : r >= 0.8 ? 'warn' : '';
  return (
    <div>
      <div className={'meter ' + cls} role="img" aria-label={`${fmtH(used)} used of ${fmtH(max)} approved`}>
        <span style={{ width: Math.min(100, r * 100).toFixed(1) + '%' }} />
        <i style={{ left: '80%' }} />
      </div>
      <div className="meter-l">
        {fmtH(used)} / {fmtH(max)}
        {cls === 'over' ? ' · limit reached' : cls === 'warn' ? ` · ${Math.round(r * 100)}%` : ''}
      </div>
    </div>
  );
}

export function TaskLink({ t, label }: { t: Pick<Task, 'id' | 'title'>; label?: string }) {
  return <Link href={`/tasks/${t.id}`} className="link">{label ?? `${code(t.id)} ${t.title}`}</Link>;
}

export function QFlag({ open, forMe }: { open: number; forMe: number }) {
  if (!open) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <span className="qflag">
        <Icon name="comment" size={12} />
        {forMe ? `${forMe} question${forMe > 1 ? 's' : ''} for you` : `${open} open question${open > 1 ? 's' : ''}`}
      </span>
    </div>
  );
}

export function Note({ kind = '', icon = 'info', children, action }: { kind?: '' | 'warn' | 'bad' | 'info' | 'ok'; icon?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={'note ' + kind}>
      <Icon name={icon} />
      <div>{children}</div>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}
