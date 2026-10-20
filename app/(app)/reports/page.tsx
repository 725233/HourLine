import Link from 'next/link';
import { requireManager, hoursFor } from '@/lib/context';
import { counted, fmtDay, fmtH, hrs, money, todayIn } from '@/lib/format';
import { period } from '@/lib/period';
import { Icon } from '@/components/Icon';
import { Empty, Note, StatusPill, TaskLink } from '@/components/ui';
import { RpcButton } from '@/components/client';
import { PeriodNav } from '@/components/PeriodNav';
import type { Entry, Payment, Rate, Task } from '@/lib/types';

export const metadata = { title: 'Reports & pay' };

export default async function Reports({ searchParams }: { searchParams: Promise<{ type?: string; anchor?: string }> }) {
  const sp = await searchParams;
  const { sb, team, settings, name } = await requireManager();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const type = sp.type === 'week' ? 'week' : 'month';
  const per = period(type, /^\d{4}-\d{2}-\d{2}$/.test(sp.anchor ?? '') ? sp.anchor! : today, tz);
  const [{ data: edata }, { data: tdata }, { data: pdata }, { data: rdata }] = await Promise.all([
    sb.from('time_entries').select('*').gte('started_at', per.from).lt('started_at', per.to),
    sb.from('tasks').select('*').neq('status', 'cancelled'),
    sb.from('payments').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('worker_rates').select('*').order('effective_from', { ascending: false }),
  ]);
  const entries = (edata ?? []) as Entry[];
  const workers = team.filter((p) => p.role === 'worker');
  const rateNow = (id: string) => ((rdata ?? []) as Rate[]).find((r) => r.worker_id === id && r.effective_from <= today);
  const rows = workers.map((w) => {
    const es = entries.filter((e) => e.worker_id === w.id);
    const c = es.filter(counted);
    const ap = c.filter((e) => e.status === 'approved');
    const pays: Record<string, number> = {};
    ap.forEach((e) => { pays[e.currency] = (pays[e.currency] ?? 0) + hrs(e) * Number(e.rate); });
    const sumH = (xs: Entry[]) => xs.reduce((s, e) => s + hrs(e), 0);
    return { w, logged: sumH(c), pending: sumH(c.filter((e) => e.status === 'pending')), approved: sumH(ap), rejected: sumH(es.filter((e) => e.status === 'rejected')), pays };
  }).filter((r) => r.w.active || r.logged > 0);
  const totals: Record<string, number> = {};
  rows.forEach((r) => Object.entries(r.pays).forEach(([c, a]) => { totals[c] = (totals[c] ?? 0) + a; }));
  const tasks = ((tdata ?? []) as Task[]).filter((t) => Number(t.max_hours) > 0);
  const hours = await hoursFor(tasks.map((t) => t.id));
  const maxV = Math.max(1, ...tasks.map((t) => Math.max(Number(t.est_hours), hours.get(t.id)?.logged ?? 0, hours.get(t.id)?.approved ?? 0)));
  const unrecorded = entries.filter((e) => counted(e) && e.status === 'approved' && !e.payment_id).length;
  const payments = (pdata ?? []) as Payment[];
  const exportHref = `/api/export?type=entries&from=${encodeURIComponent(per.from)}&to=${encodeURIComponent(per.to)}`;

  return (
    <>
      <div className="page-head"><h1>Reports &amp; pay</h1></div>
      <PeriodNav base="/reports" type={type} per={per} today={today} />
      <section className="card">
        <div className="card-h"><h2>Timesheet summary</h2><span className="muted small">{per.label} · pay uses approved hours only</span><a className="btn sm" href={exportHref}><Icon name="download" />Export entries (CSV)</a></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Worker</th><th>Current rate</th><th className="r">Logged</th><th className="r">Pending</th><th className="r">Approved</th><th className="r">Rejected</th><th className="r">Approved pay</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const rt = rateNow(r.w.id);
                return (
                  <tr key={r.w.id}>
                    <td><b>{r.w.full_name || r.w.email}</b><div className="small muted">{r.w.title}</div></td>
                    <td className="num">{rt ? money(rt.rate, rt.currency) + '/h' : <span className="muted">Not set</span>}</td>
                    <td className="r num">{fmtH(r.logged)}</td><td className="r num">{fmtH(r.pending)}</td>
                    <td className="r num"><b>{fmtH(r.approved)}</b></td><td className="r num">{fmtH(r.rejected)}</td>
                    <td className="r num">{Object.keys(r.pays).length ? Object.entries(r.pays).map(([c, a]) => <div key={c}>{money(a, c)}</div>) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              {Object.keys(totals).length ? Object.entries(totals).map(([c, a]) => <tr key={c}><td colSpan={6}>Total approved pay in {c}</td><td className="r num">{money(a, c)}</td></tr>)
                : <tr><td colSpan={7}>No approved pay in this period</td></tr>}
            </tfoot>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Pay is calculated per entry with the rate stored when that time was logged, so changing a rate later does not change past amounts.</p>
      </section>

      <section className="card">
        <div className="card-h"><h2>Estimated vs logged vs approved hours</h2><span className="muted small">All time, per task</span>
          <span className="legend"><span><i style={{ background: 'var(--line-2)' }} />Estimated</span><span><i style={{ background: 'var(--accent)' }} />Logged</span><span><i style={{ background: 'var(--ok)' }} />Approved</span></span></div>
        {tasks.length ? (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Task</th><th>Worker</th><th className="r">Estimated</th><th className="r">Max approved</th><th className="r">Logged</th><th className="r">Approved</th><th className="r">Logged vs est.</th><th>Comparison</th></tr></thead>
              <tbody>
                {tasks.map((t) => {
                  const lg = hours.get(t.id)?.logged ?? 0, ap = hours.get(t.id)?.approved ?? 0, v = lg - Number(t.est_hours);
                  return (
                    <tr key={t.id}>
                      <td><TaskLink t={t} /><div><StatusPill s={t.status} /></div></td>
                      <td>{name(t.assignee_id)}</td>
                      <td className="r num">{fmtH(t.est_hours)}</td><td className="r num">{fmtH(t.max_hours)}</td>
                      <td className="r num">{fmtH(lg)}</td><td className="r num">{fmtH(ap)}</td>
                      <td className="r num" style={{ color: v > 0 ? 'var(--bad)' : 'var(--ok)' }}>{v > 0 ? '+' : v < 0 ? '−' : ''}{fmtH(Math.abs(v))}</td>
                      <td><div className="bars" aria-hidden="true">
                        <div className="b-est" style={{ width: (Number(t.est_hours) / maxV) * 100 + '%' }} />
                        <div className="b-log" style={{ width: (lg / maxV) * 100 + '%' }} />
                        <div className="b-app" style={{ width: (ap / maxV) * 100 + '%' }} />
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty>No tasks with approved hours yet.</Empty>}
      </section>

      <section className="card">
        <div className="card-h"><h2>Payment records</h2>
          <RpcButton fn="create_payments" args={{ p_start: per.startDay, p_end: per.endDay }} icon="plus" small
            label={`Create records for ${per.label}${unrecorded ? ` (${unrecorded} entries)` : ''}`} success="Payment records created."
            confirm={{ title: 'Create payment records', body: `Groups approved, unrecorded time in ${per.label} into one record per worker and currency. Entries in a record can no longer be corrected.`, action: 'Create records' }} />
          <a className="btn sm" href="/api/export?type=payments"><Icon name="download" />Export (CSV)</a>
        </div>
        <Note kind="warn">Hourline records what is owed and lets you mark records as paid. It never sends money. Pay workers through your normal payroll or payment provider.</Note>
        {payments.length ? (
          <div className="tbl-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>Record</th><th>Worker</th><th>Period</th><th className="r">Approved hours</th><th className="r">Amount</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="num">#{p.id}</td><td>{name(p.worker_id)}</td><td>{fmtDay(p.period_start)} – {fmtDay(p.period_end)}</td>
                    <td className="r num">{fmtH(p.hours)}</td><td className="r num"><b>{money(p.amount, p.currency)}</b></td>
                    <td><span className={'pill p-' + p.status}>{p.status === 'paid' ? 'Paid' : 'Unpaid'}</span>{p.paid_at && <div className="small muted">{fmtDay(p.paid_at.slice(0, 10))} · {name(p.paid_by)}</div>}</td>
                    <td>{p.status === 'paid'
                      ? <RpcButton small fn="set_payment_status" args={{ p_payment: p.id, p_status: 'unpaid' }} label="Mark unpaid" confirm={{ title: `Mark #${p.id} as unpaid`, body: 'This only updates the record.', action: 'Mark unpaid' }} />
                      : <RpcButton small variant="primary" icon="check" fn="set_payment_status" args={{ p_payment: p.id, p_status: 'paid' }} label="Mark paid"
                          confirm={{ title: `Mark #${p.id} as paid`, body: `${name(p.worker_id)} · ${money(p.amount, p.currency)}. This only updates the record; no money is sent. Confirm you have paid this through your payroll or payment provider.`, action: 'Mark as paid' }} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No payment records yet.</Empty>}
      </section>
      <p className="small muted">Need a worker’s detail? Open <Link className="link" href="/review?tab=time&status=all">all time entries</Link>.</p>
    </>
  );
}
