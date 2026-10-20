import { getContext } from '@/lib/context';
import { TRACKABLE, code, counted, fmtDay, fmtH, hrs, money, todayIn } from '@/lib/format';
import { period } from '@/lib/period';
import { Icon } from '@/components/Icon';
import { Empty } from '@/components/ui';
import { RpcDialog } from '@/components/client';
import { EntryTable } from '@/components/EntryTable';
import { PeriodNav } from '@/components/PeriodNav';
import type { Entry, Payment, Task } from '@/lib/types';

export const metadata = { title: 'My timesheet' };

export default async function Timesheet({ searchParams }: { searchParams: Promise<{ type?: string; anchor?: string }> }) {
  const sp = await searchParams;
  const { sb, me, settings } = await getContext();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const type = sp.type === 'month' ? 'month' : 'week';
  const per = period(type, /^\d{4}-\d{2}-\d{2}$/.test(sp.anchor ?? '') ? sp.anchor! : today, tz);
  const [{ data: edata }, { data: tdata }, { data: pdata }, { data: related }] = await Promise.all([
    sb.from('time_entries').select('*').eq('worker_id', me.id).gte('started_at', per.from).lt('started_at', per.to).order('started_at', { ascending: false }),
    sb.from('tasks').select('*').eq('assignee_id', me.id),
    sb.from('payments').select('*').eq('worker_id', me.id).order('created_at', { ascending: false }),
    sb.from('time_entries').select('*').eq('worker_id', me.id).eq('kind', 'correction').eq('status', 'pending'),
  ]);
  const entries = (edata ?? []) as Entry[];
  const tasks = (tdata ?? []) as Task[];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const c = entries.filter(counted);
  const ap = c.filter((e) => e.status === 'approved');
  const pays: Record<string, number> = {};
  ap.forEach((e) => { pays[e.currency] = (pays[e.currency] ?? 0) + hrs(e) * Number(e.rate); });
  const sumH = (xs: Entry[]) => xs.reduce((s, e) => s + hrs(e), 0);
  const trackable = tasks.filter((t) => TRACKABLE.includes(t.status));
  const payments = (pdata ?? []) as Payment[];

  return (
    <>
      <div className="page-head"><h1>My timesheet</h1></div>
      <PeriodNav base="/timesheet" type={type} per={per} today={today} />
      <div className="btn-row">
        {trackable.length > 0 && (
          <RpcDialog label="Add time manually" icon="plus" variant="primary" title="Add time manually" fn="add_manual_entry" tz={tz}
            intro={<p className="note info">Use this when you forgot to start the timer. A reason is required and your manager must approve it. Times are in {tz}.</p>}
            fields={[
              { name: 'task', label: 'Task', type: 'select', options: trackable.map((t) => [String(t.id), `${code(t.id)} · ${t.title}`] as [string, string]) },
              { name: 'date', label: 'Date', type: 'date', required: true, max: today, defaultValue: today },
              { name: 'start', label: 'Start', type: 'time', required: true, defaultValue: '09:00' },
              { name: 'end', label: 'End', type: 'time', required: true, defaultValue: '10:00' },
              { name: 'summary', label: 'Work summary', type: 'textarea', required: true, minLength: 10 },
              { name: 'reason', label: 'Reason for manual entry', required: true, minLength: 5, placeholder: 'For example: Forgot to start the timer' },
            ]}
            args={{ p_task: { field: 'task', as: 'number' }, p_start: { field: 'date', as: 'datetime', time: 'start' }, p_end: { field: 'date', as: 'datetime', time: 'end' }, p_summary: { field: 'summary' }, p_reason: { field: 'reason' } }}
            submitLabel="Submit for approval" success="Manual entry sent for approval." />
        )}
        <a className="btn" href={`/api/export?type=entries&mine=1&from=${encodeURIComponent(per.from)}&to=${encodeURIComponent(per.to)}`}><Icon name="download" />Export (CSV)</a>
        <span className="small muted">Manual entries and corrections need a reason and manager approval.</span>
      </div>
      <div className="tiles">
        <div className="tile" style={{ cursor: 'default' }}><span className="v">{fmtH(sumH(c))}</span><span className="l">Logged</span></div>
        <div className="tile attn" style={{ cursor: 'default' }}><span className="v">{fmtH(sumH(c.filter((e) => e.status === 'pending')))}</span><span className="l">Pending approval</span></div>
        <div className="tile" style={{ cursor: 'default' }}><span className="v" style={{ color: 'var(--ok)' }}>{fmtH(sumH(ap))}</span><span className="l">Approved</span></div>
        <div className="tile" style={{ cursor: 'default' }}><span className="v" style={{ color: 'var(--bad)' }}>{fmtH(sumH(entries.filter((e) => e.status === 'rejected')))}</span><span className="l">Rejected</span></div>
        <div className="tile" style={{ cursor: 'default' }}><span className="v" style={{ fontSize: 18 }}>{Object.keys(pays).length ? Object.entries(pays).map(([cur, a]) => <div key={cur}>{money(a, cur)}</div>) : '—'}</span><span className="l">My approved pay</span></div>
      </div>
      <section className="card">
        <div className="card-h"><h2>Entries · {per.label}</h2><span className="tz-note">Times in {tz}</span></div>
        <EntryTable entries={entries} related={[...entries, ...((related ?? []) as Entry[])]} tz={tz} tasks={byId} showTask showPay actions="worker" />
      </section>
      <section className="card">
        <div className="card-h"><h2>My payment records</h2></div>
        {payments.length ? (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Record</th><th>Period</th><th className="r">Hours</th><th className="r">Amount</th><th>Status</th></tr></thead>
            <tbody>{payments.map((p) => <tr key={p.id}><td className="num">#{p.id}</td><td>{fmtDay(p.period_start)} – {fmtDay(p.period_end)}</td><td className="r num">{fmtH(p.hours)}</td><td className="r num">{money(p.amount, p.currency)}</td><td><span className={'pill p-' + p.status}>{p.status === 'paid' ? 'Paid' : 'Unpaid'}</span></td></tr>)}</tbody>
          </table></div>
        ) : <Empty>No payment records yet.</Empty>}
      </section>
    </>
  );
}
