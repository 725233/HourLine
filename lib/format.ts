import type { Priority, TaskStatus } from './types';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  needs_estimate: 'Needs Estimate',
  estimate_submitted: 'Estimate Submitted',
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  submitted: 'Submitted for Review',
  changes_requested: 'Changes Requested',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const STATUS_CLASS: Record<TaskStatus, string> = {
  needs_estimate: 's-est', estimate_submitted: 's-estsub', todo: 's-todo', in_progress: 's-prog', blocked: 's-blocked',
  submitted: 's-review', changes_requested: 's-changes', completed: 's-done', cancelled: 's-cancel',
};
export const STATUSES = Object.keys(STATUS_LABEL) as TaskStatus[];
export const OPEN: TaskStatus[] = ['needs_estimate', 'estimate_submitted', 'todo', 'in_progress', 'blocked', 'submitted', 'changes_requested'];
export const TRACKABLE: TaskStatus[] = ['todo', 'in_progress', 'changes_requested'];
export const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];
export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'PHP', 'INR', 'PKR', 'CAD', 'AUD', 'SAR', 'NGN', 'KES', 'ZAR', 'BRL', 'MXN'];
export const PROJECT_KINDS = ['Website development', 'Product content', 'Design', 'Marketing', 'Operations', 'Other'];

export const code = (id: number) => 'T-' + id;
export const num = (v: unknown) => Number(v ?? 0);

export function fmtH(h: number | string | null | undefined) {
  const m = Math.max(0, Math.round(num(h) * 60));
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
export function fmtClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
}
export function money(amount: number | string, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(num(amount));
  } catch {
    return currency + ' ' + num(amount).toFixed(2);
  }
}
export function fmtSize(n: number | null | undefined) {
  const b = num(n);
  return b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}

// Times are shown in the organisation's time zone.
const fmt = (tz: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o });
export const fmtDate = (iso: string, tz: string) => fmt(tz, { month: 'short', day: 'numeric' }).format(new Date(iso));
export const fmtDateY = (iso: string, tz: string) => fmt(tz, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
export const fmtTime = (iso: string, tz: string) => fmt(tz, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
export const fmtDT = (iso: string, tz: string) => fmtDate(iso, tz) + ', ' + fmtTime(iso, tz);
// Plain calendar dates (deadlines, periods) have no time zone.
export const fmtDay = (d: string | null | undefined) =>
  d ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(d + 'T12:00:00Z')) : '—';

export function ymdInTz(date: Date, tz: string) {
  const parts = Object.fromEntries(fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export const todayIn = (tz: string) => ymdInTz(new Date(), tz);

/** Converts a wall-clock date and time in a time zone to an ISO timestamp. */
export function zonedToISO(date: string, time: string, tz: string) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUTC = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (t: number) => {
    const p = Object.fromEntries(
      fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(t)).map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let guess = asUTC - offset(asUTC);
  guess = asUTC - offset(guess);
  return new Date(guess).toISOString();
}
export function hhmmInTz(iso: string, tz: string) {
  return fmtTime(iso, tz);
}

export function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

export const isOverdue = (t: { status: TaskStatus; deadline: string | null }, today: string) =>
  OPEN.includes(t.status) && !!t.deadline && t.deadline < today;
export const hrs = (e: { started_at: string; ended_at: string }) => (new Date(e.ended_at).getTime() - new Date(e.started_at).getTime()) / 3600000;
export const counted = (e: { status: string; superseded_by: number | null; kind: string }) =>
  e.status !== 'rejected' && !e.superseded_by && !(e.kind === 'correction' && e.status !== 'approved');
export const firstName = (n: string) => (n || '').split(' ')[0];
