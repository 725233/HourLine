import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { counted, fmtTime, hrs, ymdInTz } from '@/lib/format';
import type { Entry, Payment, Profile, Task } from '@/lib/types';

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formulas and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

// CSV export. Row-level security limits workers to their own entries and payments.
export async function GET(request: NextRequest) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return new NextResponse('Sign in first', { status: 401 });
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const { data: settings } = await sb.from('app_settings').select('timezone').eq('id', 1).single();
  const tz = settings?.timezone ?? 'UTC';
  const { data: people } = await sb.from('profiles').select('id, full_name, email');
  const nm = new Map(((people ?? []) as Profile[]).map((p) => [p.id, p.full_name || p.email]));
  let body: string; let filename: string;
  if (type === 'payments') {
    const { data } = await sb.from('payments').select('*').order('created_at');
    body = csv([['Record', 'Worker', 'Period start', 'Period end', 'Approved hours', 'Amount', 'Currency', 'Status', 'Paid on'],
      ...((data ?? []) as Payment[]).map((p) => [p.id, nm.get(p.worker_id), p.period_start, p.period_end, Number(p.hours).toFixed(2), Number(p.amount).toFixed(2), p.currency, p.status, p.paid_at ? ymdInTz(new Date(p.paid_at), tz) : ''])]);
    filename = 'payment-records.csv';
  } else {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    let q = sb.from('time_entries').select('*').order('started_at');
    if (from) q = q.gte('started_at', from);
    if (to) q = q.lt('started_at', to);
    if (url.searchParams.get('mine')) q = q.eq('worker_id', user.id);
    const { data } = await q;
    const entries = (data ?? []) as Entry[];
    const { data: tdata } = await sb.from('tasks').select('id, title').in('id', [...new Set(entries.map((e) => e.task_id))].concat(-1));
    const tasks = new Map(((tdata ?? []) as Task[]).map((t) => [t.id, t.title]));
    body = csv([['Entry', 'Date', 'Worker', 'Task', 'Task title', 'Start', 'End', 'Hours', 'Type', 'Status', 'Rate', 'Currency', 'Approved pay', 'Summary', 'Reason', 'Flag', 'Payment record'],
      ...entries.map((e) => [e.id, ymdInTz(new Date(e.started_at), tz), nm.get(e.worker_id), 'T-' + e.task_id, tasks.get(e.task_id) ?? '', fmtTime(e.started_at, tz), fmtTime(e.ended_at, tz),
        hrs(e).toFixed(2), e.kind, e.superseded_by ? 'replaced' : e.status, e.rate, e.currency,
        e.status === 'approved' && counted(e) ? (hrs(e) * Number(e.rate)).toFixed(2) : '0.00', e.summary, e.reason, e.flag_reason, e.payment_id ?? ''])]);
    filename = `timesheet-${from ? ymdInTz(new Date(from), tz) : 'all'}.csv`;
  }
  return new NextResponse(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' } });
}
