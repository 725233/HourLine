import Link from 'next/link';
import { requireManager, hoursFor } from '@/lib/context';
import { code, fmtDT, fmtDay, fmtH } from '@/lib/format';
import { toItems } from '@/lib/files';
import { Icon } from '@/components/Icon';
import { Meter, Note } from '@/components/ui';
import { FilterSelect, RpcButton, RpcDialog } from '@/components/client';
import { AttachmentList } from '@/components/Attachments';
import { EntryTable } from '@/components/EntryTable';
import { ReviewTime } from '@/components/ReviewTime';
import { RequestRow } from '@/components/shared';
import type { Attachment, Entry, Estimate, HourRequest, Submission, Task } from '@/lib/types';

export const metadata = { title: 'Review & approvals' };
type Tab = 'estimates' | 'work' | 'time' | 'hours';

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string; worker?: string }> }) {
  const sp = await searchParams;
  const tab: Tab = (['estimates', 'work', 'time', 'hours'] as Tab[]).includes(sp.tab as Tab) ? (sp.tab as Tab) : 'estimates';
  const { sb, team, settings, name } = await requireManager();
  const tz = settings.timezone;
  const [{ data: tdata }, { count: pendingCount }, { data: reqs }, { data: ests }] = await Promise.all([
    sb.from('tasks').select('*'),
    sb.from('time_entries').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    sb.from('hour_requests').select('*').order('created_at', { ascending: false }),
    sb.from('task_estimates').select('*').eq('status', 'submitted'),
  ]);
  const tasks = (tdata ?? []) as Task[];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const estTasks = tasks.filter((t) => t.status === 'estimate_submitted');
  const subTasks = tasks.filter((t) => t.status === 'submitted');
  const requests = (reqs ?? []) as HourRequest[];
  const pendingReqs = requests.filter((r) => r.status === 'pending');
  const tabs: [Tab, string, number][] = [['estimates', 'Time estimates', estTasks.length], ['work', 'Work submissions', subTasks.length], ['time', 'Time entries', pendingCount ?? 0], ['hours', 'Extra-hours requests', pendingReqs.length]];

  let body: React.ReactNode = null;
  if (tab === 'estimates') {
    const estOf = new Map(((ests ?? []) as Estimate[]).map((e) => [e.task_id, e]));
    body = <>
      <Note kind="info">Workers estimate the hours they need before starting. The hours you approve become the task’s paid limit. The timer stays locked until then.</Note>
      {estTasks.length ? estTasks.map((t) => {
        const e = estOf.get(t.id);
        if (!e) return null;
        return (
          <section className="card sub" key={t.id}>
            <div className="card-h" style={{ margin: 0 }}>
              <div style={{ marginRight: 'auto' }}><div className="tid">{code(t.id)}</div><h2><Link className="link" href={`/tasks/${t.id}`}>{t.title}</Link></h2>
                <div className="small muted">{name(e.worker_id)} · submitted {fmtDT(e.created_at, tz)} · due {fmtDay(t.deadline)}</div></div>
              <div style={{ textAlign: 'right' }}><div className="eyebrow">Estimate</div><div className="num" style={{ fontSize: 22, fontWeight: 600 }}>{fmtH(e.hours)}</div></div>
            </div>
            <div><h3 className="eyebrow">Expected deliverable</h3><p className="small" style={{ marginTop: 3 }}>{t.deliverable}</p></div>
            <div className="note"><div className="prose small">{e.notes}</div></div>
            <div className="btn-row">
              <RpcDialog label="Review estimate" icon="check" variant="primary" title={`Review estimate for ${code(t.id)}`} fn="decide_estimate"
                intro={<p><b>{name(e.worker_id)}</b> estimates <b className="num">{fmtH(e.hours)}</b>.</p>}
                fields={[
                  { name: 'decision', label: 'Decision', type: 'radio', options: [['true', 'Approve and set the paid hour limit'], ['false', 'Ask for a revised estimate']] },
                  { name: 'hours', label: 'Approved hours (paid limit)', type: 'number', min: 0.25, defaultValue: String(e.hours), hint: 'Defaults to the worker’s estimate.', showIf: { field: 'decision', equals: 'true' } },
                  { name: 'note', label: 'Note for the worker', type: 'textarea', placeholder: 'Required if you change the hours or ask for a revision' },
                ]}
                args={{ p_task: t.id, p_approve: { field: 'decision', as: 'bool' }, p_hours: { field: 'hours', as: 'number' }, p_note: { field: 'note' } }} submitLabel="Save decision" success="Decision saved." />
              <Link className="btn" href={`/tasks/${t.id}?tab=discussion`}><Icon name="comment" />Ask a question</Link>
            </div>
          </section>
        );
      }) : <p className="empty card">No estimates waiting for approval.</p>}
    </>;
  } else if (tab === 'work') {
    const { data: sdata } = await sb.from('submissions').select('*').in('task_id', subTasks.map((t) => t.id).concat(-1)).is('decision', null);
    const subs = (sdata ?? []) as Submission[];
    const { data: adata } = await sb.from('attachments').select('*').in('submission_id', subs.map((s) => s.id).concat(-1));
    const files = await toItems(sb, (adata ?? []) as Attachment[]);
    const hours = await hoursFor(subTasks.map((t) => t.id));
    body = <>
      <Note kind="info">Approving work and approving time are separate. Approving work marks the task Completed; logged time stays pending until you approve it under Time entries.</Note>
      {subs.length ? subs.map((s) => {
        const t = byId.get(s.task_id)!;
        const fi = files.filter((f) => (adata ?? []).find((a) => a.id === f.id)?.submission_id === s.id);
        return (
          <section className="card sub" key={s.id}>
            <div className="card-h" style={{ margin: 0 }}>
              <div style={{ marginRight: 'auto' }}><div className="tid">{code(t.id)}</div><h2><Link className="link" href={`/tasks/${t.id}?tab=work`}>{t.title}</Link></h2><div className="small muted">{name(s.worker_id)} · submitted {fmtDT(s.created_at, tz)}</div></div>
              <div style={{ width: 170 }}><Meter task={t} h={hours.get(t.id)} /></div>
            </div>
            <div><h3 className="eyebrow">Expected deliverable</h3><p className="small" style={{ marginTop: 3 }}>{t.deliverable}</p></div>
            <p className="prose">{s.summary}</p>
            <AttachmentList items={[...s.links.map((l, i) => ({ id: -1 - i - s.id * 100, kind: 'link' as const, name: l.label || l.url, href: l.url, isImage: false, size: null })), ...fi]} />
            <ul className="crit">{s.criteria.map((c, i) => <li key={i} className={c.checked ? 'on' : ''}><Icon name={c.checked ? 'check' : 'x'} /><span>{c.text}</span></li>)}</ul>
            <div className="btn-row">
              <RpcDialog label="Approve work" icon="check" variant="primary" title="Approve work" fn="decide_work"
                intro={<Note kind="info">This marks the task Completed. It does <b>not</b> approve logged time.</Note>}
                fields={[{ name: 'comment', label: 'Comment for the worker (optional)', type: 'textarea' }]}
                args={{ p_task: t.id, p_approve: true, p_comment: { field: 'comment' } }} submitLabel="Approve work" success="Work approved." />
              <RpcDialog label="Request changes" icon="undo" title="Request changes" fn="decide_work"
                intro={<Note kind="warn">The task goes back to the worker. Approved hours are not increased.</Note>}
                fields={[{ name: 'comment', label: 'What needs to change?', type: 'textarea', required: true, minLength: 5 }]}
                args={{ p_task: t.id, p_approve: false, p_comment: { field: 'comment' } }} submitLabel="Request changes" success="Changes requested." />
            </div>
          </section>
        );
      }) : <p className="empty card">No work waiting for review.</p>}
    </>;
  } else if (tab === 'time') {
    const st = sp.status ?? 'pending';
    let q = sb.from('time_entries').select('*').order('started_at', { ascending: false }).limit(500);
    if (st === 'flagged') q = q.eq('flagged', true); else if (st !== 'all') q = q.eq('status', st);
    if (sp.worker) q = q.eq('worker_id', sp.worker);
    const { data: edata } = await q;
    const entries = (edata ?? []) as Entry[];
    const origIds = entries.map((e) => e.corrects_id).filter(Boolean) as number[];
    const { data: odata } = await sb.from('time_entries').select('*').in('id', origIds.concat(-1));
    const originals = Object.fromEntries(((odata ?? []) as Entry[]).map((o) => [o.id, o]));
    const names = Object.fromEntries(team.map((p) => [p.id, p.full_name || p.email]));
    const titles = Object.fromEntries(tasks.map((t) => [t.id, t.title]));
    body = <>
      <div className="filters">
        <FilterSelect name="status" label="Entry status" value={st} options={[['pending', 'Pending approval'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['flagged', 'Flagged sessions'], ['all', 'All entries']]} />
        <FilterSelect name="worker" label="Worker" value={sp.worker ?? ''} options={[['', 'All workers'], ...team.filter((p) => p.role === 'worker').map((w) => [w.id, w.full_name || w.email] as [string, string])]} />
      </div>
      <Note kind="info">Only approved hours count toward pay. Each entry keeps the hourly rate that applied when it was logged. Check flagged sessions before approving. Times are in {tz}.</Note>
      {st === 'pending'
        ? <ReviewTime entries={entries} names={names} titles={titles} tz={tz} originals={originals} />
        : <EntryTable entries={entries} related={[...entries, ...Object.values(originals)]} tz={tz} showWorker showTask name={name} tasks={byId} showPay actions="manager" />}
    </>;
  } else {
    const hours = await hoursFor(pendingReqs.map((r) => r.task_id));
    body = <>
      {pendingReqs.length ? pendingReqs.map((r) => {
        const t = byId.get(r.task_id)!;
        return (
          <section className="card sub" key={r.id}>
            <div className="card-h" style={{ margin: 0 }}>
              <div style={{ marginRight: 'auto' }}><h2>{name(r.worker_id)} requests <span className="num">+{fmtH(r.hours)}</span></h2><div className="small muted"><Link className="link" href={`/tasks/${t.id}`}>{code(t.id)} {t.title}</Link> · requested {fmtDT(r.created_at, tz)}</div></div>
              <div style={{ width: 170 }}><Meter task={t} h={hours.get(t.id)} /></div>
            </div>
            <p className="prose">{r.reason}</p>
            <p className="small muted">If approved, max approved hours go from <b className="num">{fmtH(t.max_hours)}</b> to <b className="num">{fmtH(Number(t.max_hours) + Number(r.hours))}</b>. Estimated: {fmtH(t.est_hours)}.</p>
            <div className="btn-row">
              <RpcButton fn="decide_hours" args={{ p_request: r.id, p_approve: true, p_note: '' }} label={`Approve ${fmtH(r.hours)}`} icon="check" variant="primary" success="Extra hours approved." />
              <RpcDialog label="Reject" icon="x" title="Reject request" fn="decide_hours" fields={[{ name: 'note', label: 'Note for the worker', type: 'textarea', required: true, minLength: 3 }]}
                args={{ p_request: r.id, p_approve: false, p_note: { field: 'note' } }} submitLabel="Reject request" danger />
            </div>
          </section>
        );
      }) : <p className="empty card">No pending requests.</p>}
      {requests.some((r) => r.status !== 'pending') && (
        <section className="card"><div className="card-h"><h2>Decided requests</h2></div>
          <div className="list">{requests.filter((r) => r.status !== 'pending').slice(0, 50).map((r) => <RequestRow key={r.id} r={r} task={byId.get(r.task_id)} tz={tz} name={name} />)}</div>
        </section>
      )}
    </>;
  }

  return (
    <>
      <div className="page-head"><h1>Review &amp; approvals</h1></div>
      <div className="tabs tabbar" role="tablist">
        {tabs.map(([k, l, n]) => <Link key={k} role="tab" aria-selected={tab === k} href={`/review?tab=${k}`}>{l}<span className="n">{n}</span></Link>)}
      </div>
      {body}
    </>
  );
}
