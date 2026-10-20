import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getContext, hoursFor } from '@/lib/context';
import { OPEN, TRACKABLE, ago, code, counted, fmtDT, fmtDay, fmtH, hrs, isOverdue, todayIn } from '@/lib/format';
import { toItems } from '@/lib/files';
import { openQuestions, waitingOn } from '@/lib/questions';
import { Icon } from '@/components/Icon';
import { Empty, Meter, Note, Prio, StatusPill } from '@/components/ui';
import { Clock, RpcButton, RpcDialog } from '@/components/client';
import { AddFiles, AttachmentList } from '@/components/Attachments';
import { Discussion } from '@/components/Discussion';
import { EntryTable } from '@/components/EntryTable';
import { RequestRow, StopTimer } from '@/components/shared';
import type { Activity, Attachment, Comment, Entry, Estimate, HourRequest, Submission, Task, Timer } from '@/lib/types';

type Tab = 'overview' | 'time' | 'work' | 'discussion' | 'activity';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: code(Number((await params).id)) };
}

export default async function TaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; ask?: string }> }) {
  const id = Number((await params).id);
  const sp = await searchParams;
  const tab: Tab = (['overview', 'time', 'work', 'discussion', 'activity'] as Tab[]).includes(sp.tab as Tab) ? (sp.tab as Tab) : 'overview';
  const { sb, me, isManager, team, settings, name } = await getContext();
  const tz = settings.timezone;
  const { data: tdata } = await sb.from('tasks').select('*').eq('id', id).maybeSingle();
  if (!tdata) notFound();
  const t = tdata as Task;
  const [{ data: proj }, { data: est }, { data: reqs }, { data: subs }, { data: com }, { data: att }, { data: ents }, { data: act }, { data: myTimer }] = await Promise.all([
    sb.from('projects').select('name').eq('id', t.project_id).maybeSingle(),
    sb.from('task_estimates').select('*').eq('task_id', id).order('created_at', { ascending: false }),
    sb.from('hour_requests').select('*').eq('task_id', id).order('created_at', { ascending: false }),
    sb.from('submissions').select('*').eq('task_id', id).order('created_at', { ascending: false }),
    sb.from('comments').select('*').eq('task_id', id),
    sb.from('attachments').select('*').eq('task_id', id).order('created_at'),
    sb.from('time_entries').select('*').eq('task_id', id).order('started_at', { ascending: false }),
    sb.from('activity').select('*').eq('task_id', id).order('created_at', { ascending: false }).limit(300),
    sb.from('timers').select('*').eq('worker_id', me.id).maybeSingle(),
  ]);
  const h = (await hoursFor([id])).get(id);
  const estimates = (est ?? []) as Estimate[];
  const requests = (reqs ?? []) as HourRequest[];
  const submissions = (subs ?? []) as Submission[];
  const comments = (com ?? []) as Comment[];
  const attachments = (att ?? []) as Attachment[];
  const entries = (ents ?? []) as Entry[];
  const activity = (act ?? []) as Activity[];
  const items = await toItems(sb, attachments);
  const itemOf = new Map(items.map((i) => [i.id, i]));
  const taskFiles = attachments.filter((a) => !a.comment_id && !a.submission_id).map((a) => itemOf.get(a.id)!);
  const commentFiles: Record<number, typeof items> = {};
  const subFiles: Record<number, typeof items> = {};
  attachments.forEach((a) => {
    if (a.comment_id) (commentFiles[a.comment_id] ??= []).push(itemOf.get(a.id)!);
    if (a.submission_id) (subFiles[a.submission_id] ??= []).push(itemOf.get(a.id)!);
  });
  const today = todayIn(tz);
  const mine = t.assignee_id === me.id;
  const used = (h?.logged ?? 0) + (h?.running ?? 0);
  const max = Number(t.max_hours);
  const remaining = Math.max(0, max - used);
  const ratio = max > 0 ? used / max : 0;
  const pendingReq = requests.find((r) => r.status === 'pending');
  const latestEst = estimates[0];
  const tm = myTimer as Timer | null;
  const runningHere = tm?.task_id === id;
  const qs = await openQuestions(sb, [id]);
  const roles = new Map(team.map((p) => [p.id, p.role]));
  const waiting = waitingOn(qs, me, () => t.assignee_id, (x) => roles.get(x));
  const names = Object.fromEntries(team.map((p) => [p.id, p.full_name || p.email]));
  const managers = team.filter((p) => p.role === 'manager').map((p) => p.id);
  const assignee = name(t.assignee_id);
  const tabHref = (k: Tab) => `/tasks/${id}${k === 'overview' ? '' : '?tab=' + k}`;
  const tabs: [Tab, string, number][] = [
    ['overview', 'Overview', 0], ['time', 'Time sessions', entries.length], ['work', 'Submissions', submissions.length],
    ['discussion', 'Discussion' + (qs.length ? ` · ${qs.length} open question${qs.length > 1 ? 's' : ''}` : ''), comments.length],
    ['activity', 'Activity', activity.length],
  ];

  /* ---------- actions ---------- */
  const actions: React.ReactNode[] = [];
  const estimateDialog = (primary: boolean) => (
    <RpcDialog key="est" label={latestEst?.status === 'revise' ? 'Revise time estimate' : 'Submit time estimate'} icon="clock" variant={primary ? 'primary' : ''} title={`Time estimate for ${code(id)}`} fn="submit_estimate"
      intro={<>
        <div className="note"><div><b>Expected deliverable:</b> {t.deliverable}<ul className="crit" style={{ marginTop: 6 }}>{t.criteria.map((c, i) => <li key={i}><Icon name="check" /><span>{c}</span></li>)}</ul></div></div>
        {latestEst?.status === 'revise' && <Note kind="warn" icon="undo"><b>Revision requested:</b> {latestEst.note}</Note>}
      </>}
      fields={[
        { name: 'hours', label: 'Hours needed', type: 'number', required: true, min: 0.25, max: 500, defaultValue: latestEst ? String(latestEst.hours) : '', hint: 'Your paid time on this task is capped at the hours your manager approves.' },
        { name: 'notes', label: 'How you got this number', type: 'textarea', required: true, minLength: 10, defaultValue: latestEst?.notes ?? '', placeholder: 'Break the work into steps with hours for each, for example:\nResearch and outline: 1h\nFirst draft: 3h\nRevisions: 1h', hint: 'A short breakdown helps your manager approve quickly. Unsure about scope? Ask a question first.' },
      ]}
      args={{ p_task: id, p_hours: { field: 'hours', as: 'number' }, p_notes: { field: 'notes' } }} submitLabel="Send for approval" success="Estimate sent. You’ll be notified when it’s approved." />
  );
  const requestHours = (primary: boolean) => (
    <RpcDialog key="rh" label="Request more hours" icon="plus" variant={primary ? 'primary' : 'ghost'} title="Request more hours" fn="request_hours"
      intro={<p className="muted">{code(id)} · used <b className="num">{fmtH(used)}</b> of <b className="num">{fmtH(max)}</b> approved.</p>}
      fields={[
        { name: 'hours', label: 'Extra hours needed', type: 'number', required: true, min: 0.25, max: 200, defaultValue: '2' },
        { name: 'reason', label: 'Reason', type: 'textarea', required: true, minLength: 10, placeholder: 'Explain what the extra time is for', hint: 'Time already logged is kept either way.' },
      ]}
      args={{ p_task: id, p_hours: { field: 'hours', as: 'number' }, p_reason: { field: 'reason' } }} submitLabel="Send request" success="Request sent to your manager." />
  );
  if (isManager) {
    if (t.status === 'estimate_submitted' && latestEst?.status === 'submitted') {
      actions.push(
        <RpcDialog key="de" label="Review estimate" icon="check" variant="primary" title={`Review estimate for ${code(id)}`} fn="decide_estimate"
          intro={<><p><b>{name(latestEst.worker_id)}</b> estimates <b className="num">{fmtH(latestEst.hours)}</b>.</p><div className="note"><div className="prose small">{latestEst.notes}</div></div></>}
          fields={[
            { name: 'decision', label: 'Decision', type: 'radio', options: [['true', 'Approve and set the paid hour limit'], ['false', 'Ask for a revised estimate']] },
            { name: 'hours', label: 'Approved hours (paid limit)', type: 'number', min: 0.25, defaultValue: String(latestEst.hours), hint: 'Defaults to the worker’s estimate. The worker can request more hours later.', showIf: { field: 'decision', equals: 'true' } },
            { name: 'note', label: 'Note for the worker', type: 'textarea', placeholder: 'Required if you change the hours or ask for a revision' },
          ]}
          args={{ p_task: id, p_approve: { field: 'decision', as: 'bool' }, p_hours: { field: 'hours', as: 'number' }, p_note: { field: 'note' } }} submitLabel="Save decision" success="Decision saved." />,
      );
    }
    if (t.status === 'submitted') {
      actions.push(
        <RpcDialog key="aw" label="Approve work" icon="check" variant="primary" title="Approve work" fn="decide_work"
          intro={<Note kind="info">This marks the task Completed. It does <b>not</b> approve logged time. Pending time entries stay pending until you approve them separately.</Note>}
          fields={[{ name: 'comment', label: 'Comment for the worker (optional)', type: 'textarea', placeholder: 'Thanks, this is ready.' }]}
          args={{ p_task: id, p_approve: true, p_comment: { field: 'comment' } }} submitLabel="Approve work" success="Work approved. Review time entries separately." />,
        <RpcDialog key="rc" label="Request changes" icon="undo" title="Request changes" fn="decide_work"
          intro={<Note kind="warn">The task goes back to the worker as Changes Requested. Approved hours are <b>not</b> increased. If the fix needs more time, the worker can request it.</Note>}
          fields={[{ name: 'comment', label: 'What needs to change?', type: 'textarea', required: true, minLength: 5 }]}
          args={{ p_task: id, p_approve: false, p_comment: { field: 'comment' } }} submitLabel="Request changes" success="Changes requested." />,
      );
    }
    if (t.status === 'blocked') actions.push(<RpcButton key="rb" fn="resolve_blocker" args={{ p_task: id }} label="Mark blocker resolved" icon="check" success="Blocker resolved." />);
    actions.push(<Link key="ed" className="btn" href={`/tasks/${id}/edit`}><Icon name="edit" />Edit task</Link>);
    if (t.status !== 'cancelled') actions.push(<Link key="msg" className="btn" href={`/tasks/${id}?tab=discussion&ask=1`}><Icon name="comment" />Message {assignee.split(' ')[0]}</Link>);
    if (OPEN.includes(t.status)) {
      actions.push(
        <RpcDialog key="ct" label="Cancel task" icon="x" variant="ghost" title="Cancel task" fn="cancel_task"
          intro={<p className="muted">The task moves to Cancelled. Logged time is kept and still needs approval or rejection.</p>}
          fields={[{ name: 'reason', label: 'Reason', required: true, minLength: 3 }]} args={{ p_task: id, p_reason: { field: 'reason' } }} submitLabel="Cancel task" danger />,
      );
    } else {
      actions.push(<RpcButton key="ro" fn="reopen_task" args={{ p_task: id }} label="Reopen task" icon="undo" confirm={{ title: 'Reopen task', body: `${code(id)} goes back to the worker. Approved hours stay as they are.`, action: 'Reopen' }} />);
    }
  } else if (mine) {
    if (t.status === 'needs_estimate') actions.push(estimateDialog(true));
    if (runningHere) actions.push(<StopTimer key="st" />);
    else if (TRACKABLE.includes(t.status)) {
      if (remaining > 0) actions.push(<RpcButton key="go" fn="start_timer" args={{ p_task: id }} label="Start timer" icon="play" variant="primary" success={`Timer started on ${code(id)}`} />);
      else if (!pendingReq) actions.push(requestHours(true));
    }
    if (t.status === 'todo') actions.push(<RpcButton key="ms" fn="mark_started" args={{ p_task: id }} label="Mark as started" icon="play" />);
    if (t.status === 'in_progress' || t.status === 'changes_requested') {
      actions.push(
        <RpcDialog key="sw" label="Submit for review" icon="send" title="Submit work for review" fn="submit_work"
          intro={<p className="muted small"><b>Expected deliverable:</b> {t.deliverable}</p>}
          fields={[
            { name: 'summary', label: 'Summary of completed work', type: 'textarea', required: true, minLength: 10, placeholder: 'What did you deliver and where can the manager find it?' },
            { name: 'links', label: 'Links (one per line, optional label before a |)', type: 'textarea', placeholder: 'Final doc | https://docs.example.com/...' },
            { name: 'files', label: 'Files or screenshots', type: 'files' },
            { name: 'crit', label: 'Acceptance criteria: check each one you met', type: 'checks', options: t.criteria.map((c, i) => [String(i), c] as [string, string]) },
          ]}
          validate={[{ field: 'crit', allOf: t.criteria.length, message: 'Check every acceptance criterion before submitting. If one can’t be met, ask a question or report a blocker.' }]}
          files={{ field: 'files', task: id, link: 'submission' }}
          args={{ p_task: id, p_summary: { field: 'summary' }, p_links: { field: 'links', as: 'links' }, p_checked: { field: 'crit', as: 'intArray' } }}
          submitLabel="Submit for review" success="Work submitted for review." />,
      );
    }
    if (TRACKABLE.includes(t.status)) {
      actions.push(
        <RpcDialog key="bl" label="Report blocker" icon="flag" title="Report a blocker" fn="report_blocker"
          intro={<p className="muted">Tell your manager what is stopping you. The task moves to Blocked and a running timer on it is stopped.</p>}
          fields={[{ name: 'text', label: 'What is blocking you?', type: 'textarea', required: true, minLength: 5, placeholder: 'For example: I need the API keys for the payment sandbox' }]}
          args={{ p_task: id, p_text: { field: 'text' } }} submitLabel="Report blocker" success="Blocker reported. Your manager has been notified." />,
      );
    }
    if (t.status === 'blocked') actions.push(<RpcButton key="rb" fn="resolve_blocker" args={{ p_task: id }} label="Mark blocker resolved" icon="check" />);
    if (TRACKABLE.includes(t.status)) {
      actions.push(
        <RpcDialog key="man" label="Add time manually" icon="clock" title="Add time manually" fn="add_manual_entry" tz={tz}
          intro={<Note kind="info">Use this when you forgot to start the timer. A reason is required and your manager must approve it. Times are in {tz}.</Note>}
          fields={[
            { name: 'date', label: 'Date', type: 'date', required: true, max: today, defaultValue: today },
            { name: 'start', label: 'Start', type: 'time', required: true, defaultValue: '09:00' },
            { name: 'end', label: 'End', type: 'time', required: true, defaultValue: '10:00' },
            { name: 'summary', label: 'Work summary', type: 'textarea', required: true, minLength: 10 },
            { name: 'reason', label: 'Reason for manual entry', required: true, minLength: 5, placeholder: 'For example: Forgot to start the timer' },
          ]}
          args={{ p_task: id, p_start: { field: 'date', as: 'datetime', time: 'start' }, p_end: { field: 'date', as: 'datetime', time: 'end' }, p_summary: { field: 'summary' }, p_reason: { field: 'reason' } }}
          submitLabel="Submit for approval" success="Manual entry sent for approval." />,
      );
    }
    const atLimitPrimary = TRACKABLE.includes(t.status) && remaining <= 0;
    if (OPEN.includes(t.status) && max > 0 && t.status !== 'estimate_submitted' && !pendingReq && !atLimitPrimary) actions.push(requestHours(false));
    if (t.status !== 'cancelled') actions.push(<Link key="ask" className="btn" href={`/tasks/${id}?tab=discussion&ask=1`}><Icon name="comment" />Ask a question</Link>);
  }

  /* ---------- notes ---------- */
  const notes: React.ReactNode[] = [];
  if (t.status === 'needs_estimate') notes.push(<Note key="ne" kind="warn" icon="clock">
    <b>{isManager ? `Waiting for ${assignee}’s time estimate.` : 'Before you start, tell your manager how many hours this task needs.'}</b>{' '}
    {latestEst?.status === 'revise' && 'The last estimate was sent back for revision. '}{isManager ? 'Work and the timer start once you approve it.' : 'The timer unlocks once the estimate is approved.'}</Note>);
  if (t.status === 'estimate_submitted' && latestEst) notes.push(<Note key="es" kind="info" icon="clock">
    <b>{isManager ? `${assignee} estimates ${fmtH(latestEst.hours)}.` : `Your estimate of ${fmtH(latestEst.hours)} is waiting for approval.`}</b>{' '}
    {isManager ? 'Approve it, approve a different number, or ask for a revision.' : 'You can ask questions while you wait.'}</Note>);
  if (OPEN.includes(t.status) && max > 0) {
    if (ratio >= 1) notes.push(<Note key="lim" kind="bad" icon="alert"><b>All approved hours are used.</b> {isManager ? 'The worker can’t log more paid time until more hours are approved.' : 'You can’t log more paid time until a manager approves more hours. Time you already logged is kept.'}{pendingReq && <> A request for <b>{fmtH(pendingReq.hours)}</b> is waiting for approval.</>}</Note>);
    else if (ratio >= 0.8) notes.push(<Note key="w80" kind="warn" icon="alert"><b>{Math.round(ratio * 100)}% of approved hours used.</b> {fmtH(remaining)} left.{!isManager && ' The timer stops automatically at the limit.'}{pendingReq && ` Request for ${fmtH(pendingReq.hours)} pending.`}</Note>);
  }
  if (isManager && pendingReq) notes.push(<Note key="req" kind="info" icon="plus" action={<div className="btn-row">
    <RpcButton fn="decide_hours" args={{ p_request: pendingReq.id, p_approve: true, p_note: '' }} label="Approve" variant="primary" small success="Extra hours approved." />
    <RpcDialog small label="Reject" title="Reject request" fn="decide_hours" fields={[{ name: 'note', label: 'Note for the worker', type: 'textarea', required: true, minLength: 3 }]} args={{ p_request: pendingReq.id, p_approve: false, p_note: { field: 'note' } }} submitLabel="Reject request" danger />
  </div>}><b>{name(pendingReq.worker_id)} requests {fmtH(pendingReq.hours)} more.</b> {pendingReq.reason}</Note>);
  if (t.status === 'blocked' && t.blocker_text) notes.push(<Note key="bl" kind="bad" icon="flag"><b>Blocked</b> · reported by {name(t.blocker_by)} {t.blocker_at && ago(t.blocker_at)}<br />{t.blocker_text}</Note>);
  if (t.status === 'changes_requested') { const s = submissions.find((x) => x.decision === 'changes'); if (s) notes.push(<Note key="cr" kind="warn" icon="undo"><b>Changes requested</b> by {name(s.decided_by)}<br />{s.comment}</Note>); }
  if (qs.length) {
    const first = waiting[0]?.q ?? qs[0].q;
    notes.push(<Note key="q" kind={waiting.length ? 'warn' : 'info'} icon="comment" action={<Link className="btn sm" href={tabHref('discussion')}>{waiting.length ? 'Answer' : 'View'}</Link>}>
      <b>{waiting.length ? `${waiting.length} question${waiting.length > 1 ? 's' : ''} waiting for your answer` : `${qs.length} open question${qs.length > 1 ? 's' : ''}`}</b><br />{name(first.author_id)}: “{first.body.slice(0, 120)}{first.body.length > 120 ? '…' : ''}”</Note>);
  }
  if (h?.running_since) notes.push(<Note key="run" kind="ok" icon="clock"><b>Timer running</b> for {name(h.running_worker)} since {fmtDT(h.running_since, tz)} · <Clock since={h.running_since} /></Note>);

  return (
    <>
      <Link className="back" href="/tasks">← {isManager ? 'Tasks' : 'My tasks'}</Link>
      <section className="task-head">
        <div>
          <div className="tid">{code(id)} · {proj?.name}</div>
          <h1 style={{ fontSize: 20, marginTop: 2 }}>{t.title}</h1>
          <div className="btn-row" style={{ marginTop: 8 }}><StatusPill s={t.status} /><Prio p={t.priority} />{isOverdue(t, today) && <span className="pill s-blocked">Overdue</span>}</div>
        </div>
        {actions.length > 0 && <div className="btn-row">{actions}</div>}
        <div className="tabs tabbar" role="tablist">
          {tabs.map(([k, l, n]) => <Link key={k} role="tab" aria-selected={tab === k} href={tabHref(k)}>{l}{n > 0 && <span className="n">{n}</span>}</Link>)}
        </div>
      </section>

      {tab === 'overview' && (
        <>
          {notes}
          {estimates.length > 0 && (
            <section className="card">
              <div className="card-h"><h3>Time estimates</h3><span className="small muted">Submitted by the worker, approved by a manager</span></div>
              <div className="list">
                {estimates.map((e) => (
                  <div className="li" key={e.id}>
                    <span className={'li-ic ' + (e.status === 'approved' ? 'ok' : e.status === 'revise' ? 'warn' : 'violet')}><Icon name="clock" /></span>
                    <div className="li-main">
                      <span><b>{name(e.worker_id)}</b> estimated <b className="num">{fmtH(e.hours)}</b> · <span className="faint small">{fmtDT(e.created_at, tz)}</span></span>
                      <span className="prose small">{e.notes}</span>
                      {e.status === 'approved' && <span className="small"><b>Approved by {name(e.decided_by)}:</b> <span className="num">{fmtH(e.approved_hours)}</span> paid limit{e.note && ` · ${e.note}`}</span>}
                      {e.status === 'revise' && <span className="small"><b>{name(e.decided_by)} asked for a revision:</b> {e.note}</span>}
                    </div>
                    {e.status === 'approved' ? <span className="pill e-approved">Approved</span> : e.status === 'revise' ? <span className="pill s-changes">Revision requested</span> : <span className="pill e-pending">Waiting for approval</span>}
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="card">
            <dl className="kv">
              <div><dt>Assigned to</dt><dd>{assignee}</dd></div>
              <div><dt>Deadline</dt><dd>{fmtDay(t.deadline)}</dd></div>
              <div><dt>Estimated</dt><dd className="num">{Number(t.est_hours) > 0 ? fmtH(t.est_hours) : '—'}</dd></div>
              <div><dt>Max approved</dt><dd className="num">{max > 0 ? fmtH(max) : '—'}</dd></div>
              <div><dt>Logged</dt><dd className="num">{fmtH(h?.logged)}</dd></div>
              <div><dt>Approved time</dt><dd className="num">{fmtH(h?.approved)}</dd></div>
              <div><dt>Remaining</dt><dd className="num">{max > 0 ? fmtH(remaining) : '—'}</dd></div>
            </dl>
            <div style={{ marginTop: 14 }}><Meter task={t} h={h} /><div className="small faint" style={{ marginTop: 2 }}>The marker shows the 80% warning point. Logged includes time waiting for approval.</div></div>
          </section>
          <section className="card">
            <h3 className="eyebrow">Description</h3><p className="prose" style={{ marginTop: 6 }}>{t.description || '—'}</p>
            <h3 className="eyebrow" style={{ marginTop: 14 }}>Expected deliverable</h3><p className="prose" style={{ marginTop: 6 }}>{t.deliverable || '—'}</p>
            <h3 className="eyebrow" style={{ marginTop: 14 }}>Acceptance criteria</h3>
            <ul className="crit" style={{ marginTop: 6 }}>{t.criteria.map((c, i) => <li key={i}><Icon name="check" /><span>{c}</span></li>)}</ul>
          </section>
          <section className="card">
            <div className="card-h"><h3>Attachments & links</h3>
              {t.status !== 'cancelled' && <>
                <AddFiles taskId={id} />
                <RpcDialog small label="Add link" icon="link" title="Add link" fn="add_link"
                  fields={[{ name: 'label', label: 'Label', placeholder: 'Design file' }, { name: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://' }]}
                  args={{ p_task: id, p_label: { field: 'label' }, p_url: { field: 'url' } }} submitLabel="Add link" />
              </>}
            </div>
            <AttachmentList items={taskFiles} />
          </section>
          {requests.length > 0 && (
            <section className="card"><div className="card-h"><h3>Additional-hours requests</h3></div>
              <div className="list">{requests.map((r) => <RequestRow key={r.id} r={r} tz={tz} name={name} />)}</div>
            </section>
          )}
        </>
      )}

      {tab === 'time' && (
        <>
          {h?.running_since && <Note kind="ok" icon="clock"><b>Running now:</b> {name(h.running_worker)} since {fmtDT(h.running_since, tz)} · <Clock since={h.running_since} /></Note>}
          <div className="legend">
            <span><b className="num">{fmtH(h?.pending)}</b>&nbsp;pending</span>
            <span><b className="num">{fmtH(h?.approved)}</b>&nbsp;approved</span>
            <span><b className="num">{fmtH(entries.filter((e) => e.status === 'rejected').reduce((s, e) => s + hrs(e), 0))}</b>&nbsp;rejected{!isManager && ' (yours)'}</span>
          </div>
          <Note kind="info">Logged time is never deleted or edited in place. Corrections are added as new entries that a manager approves or rejects; the original stays in the history. Times are in {tz}.</Note>
          <EntryTable entries={entries} tz={tz} showWorker={isManager} name={name} showPay={isManager || mine} actions={isManager ? 'manager' : 'worker'} />
        </>
      )}

      {tab === 'work' && (
        <>
          {isManager && <Note kind="info">Approving work and approving time are separate. Approving a deliverable marks the task Completed but does not approve logged hours. Review time in <Link className="link" href="/review?tab=time">Review &amp; approvals</Link>.</Note>}
          {submissions.length ? submissions.map((s) => (
            <section className="card sub" key={s.id}>
              <div className="card-h" style={{ margin: 0 }}>
                <h3>Submission #{s.id}</h3><span className="small muted">{name(s.worker_id)} · {fmtDT(s.created_at, tz)}</span>
                {s.decision === 'approved' ? <span className="pill s-done">Work approved</span> : s.decision === 'changes' ? <span className="pill s-changes">Changes requested</span> : <span className="pill s-review">Waiting for review</span>}
              </div>
              <p className="prose">{s.summary}</p>
              <AttachmentList items={[...s.links.map((l, i) => ({ id: -1 - i - s.id * 100, kind: 'link' as const, name: l.label || l.url, href: l.url, isImage: false, size: null })), ...(subFiles[s.id] ?? [])]} />
              <ul className="crit">{s.criteria.map((c, i) => <li key={i} className={c.checked ? 'on' : ''}><Icon name={c.checked ? 'check' : 'x'} /><span>{c.text}</span></li>)}</ul>
              {s.decision && <Note kind={s.decision === 'approved' ? 'ok' : 'warn'} icon={s.decision === 'approved' ? 'check' : 'undo'}><b>{name(s.decided_by)}</b> · {s.decided_at && fmtDT(s.decided_at, tz)}{s.comment && <><br />{s.comment}</>}</Note>}
            </section>
          )) : <Empty>No work submitted yet.</Empty>}
        </>
      )}

      {tab === 'discussion' && (
        <Discussion taskId={id} comments={comments} files={commentFiles} names={names} managers={managers} meId={me.id} isManager={isManager}
          assigneeName={assignee} closed={t.status === 'cancelled'} waitingCount={waiting.length} tz={tz}
          startKind={sp.ask ? (isManager ? 'comment' : 'question') : undefined} />
      )}

      {tab === 'activity' && (
        <section className="card">
          {activity.length ? activity.map((a) => (
            <div className="act" key={a.id}><time>{fmtDT(a.created_at, tz)}</time><div><b>{name(a.actor_id)}</b> {a.body}</div></div>
          )) : <Empty>No activity recorded.</Empty>}
        </section>
      )}
    </>
  );
}
