import Link from 'next/link';
import { getContext, hoursFor } from '@/lib/context';
import { OPEN, TRACKABLE, ago, code, counted, fmtDT, fmtDay, fmtH, hrs, isOverdue, money, todayIn } from '@/lib/format';
import { openQuestions, waitingOn } from '@/lib/questions';
import { preset, weekStart, addDays } from '@/lib/period';
import { zonedToISO } from '@/lib/format';
import { Icon } from '@/components/Icon';
import { Empty, Meter, Note, Prio, StatusPill, TaskLink } from '@/components/ui';
import { Clock, FilterSelect, RpcButton, RpcDialog } from '@/components/client';
import { STATUS_LABEL, STATUSES } from '@/lib/format';
import type { Entry, Estimate, HourRequest, Hours, Task, Timer } from '@/lib/types';
import { EntryTable } from '@/components/EntryTable';
import { RequestRow, StopTimer } from '@/components/shared';

export const metadata = { title: 'Dashboard' };

type SP = Promise<{ worker?: string; project?: string; status?: string; period?: string }>;

export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const ctx = await getContext();
  return ctx.isManager ? <ManagerDashboard sp={await searchParams} /> : <WorkerDashboard />;
}

function Tile({ v, label, icon, href, cls = '' }: { v: React.ReactNode; label: string; icon: string; href?: string; cls?: string }) {
  const inner = <><span className="v">{v}</span><span className="l"><Icon name={icon} />{label}</span></>;
  return href ? <Link className={'tile ' + cls} href={href} style={{ textDecoration: 'none', color: 'inherit' }}>{inner}</Link>
    : <div className={'tile ' + cls} style={{ cursor: 'default' }}>{inner}</div>;
}

async function ManagerDashboard({ sp }: { sp: Awaited<SP> }) {
  const { sb, me, team, settings, name } = await getContext();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const per = preset(sp.period ?? 'month', tz);
  const [{ data: tdata }, { data: pdata }, { data: pend }, { data: reqs }, { data: ests }, { data: timers }] = await Promise.all([
    sb.from('tasks').select('*'),
    sb.from('projects').select('*').order('name'),
    sb.from('time_entries').select('*').eq('status', 'pending'),
    sb.from('hour_requests').select('*').eq('status', 'pending'),
    sb.from('task_estimates').select('*').eq('status', 'submitted'),
    sb.from('timers').select('*'),
  ]);
  let apprQ = sb.from('time_entries').select('*').eq('status', 'approved').is('superseded_by', null);
  if (per) apprQ = apprQ.gte('started_at', per.from).lt('started_at', per.to);
  const { data: appr } = await apprQ;

  const all = (tdata ?? []) as Task[];
  const byId = new Map(all.map((t) => [t.id, t]));
  const inProj = (id: number) => !sp.project || byId.get(id)?.project_id === sp.project;
  const tasks = all.filter((t) => (!sp.worker || t.assignee_id === sp.worker) && (!sp.project || t.project_id === sp.project) && (!sp.status || t.status === sp.status));
  const hours = await hoursFor(tasks.map((t) => t.id));
  const pct = (t: Task) => (t.max_hours > 0 ? ((hours.get(t.id)?.logged ?? 0) + (hours.get(t.id)?.running ?? 0)) / Number(t.max_hours) : 0);
  const entryOk = (e: { worker_id: string; task_id: number }) => (!sp.worker || e.worker_id === sp.worker) && inProj(e.task_id);
  const active = tasks.filter((t) => OPEN.includes(t.status));
  const overdue = tasks.filter((t) => isOverdue(t, today));
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const inReview = tasks.filter((t) => t.status === 'submitted');
  const estimating = tasks.filter((t) => t.status === 'estimate_submitted');
  const pending = ((pend ?? []) as Entry[]).filter((e) => entryOk(e) && (!per || (e.started_at >= per.from && e.started_at < per.to)));
  const requests = ((reqs ?? []) as HourRequest[]).filter(entryOk);
  const near = active.filter((t) => pct(t) >= 0.8).sort((a, b) => pct(b) - pct(a));
  const byCur: Record<string, { amt: number; h: number }> = {};
  ((appr ?? []) as Entry[]).filter(entryOk).forEach((e) => {
    const c = (byCur[e.currency] ??= { amt: 0, h: 0 }); c.amt += hrs(e) * Number(e.rate); c.h += hrs(e);
  });
  const qs = await openQuestions(sb, tasks.map((t) => t.id));
  const roles = new Map(team.map((p) => [p.id, p.role]));
  const waiting = waitingOn(qs, me, (id) => byId.get(id)?.assignee_id, (id) => roles.get(id));
  const flagged = ((pend ?? []) as Entry[]).filter((e) => e.flagged && entryOk(e));
  const estMap = new Map(((ests ?? []) as Estimate[]).map((e) => [e.task_id, e]));
  const running = ((timers ?? []) as Timer[]).filter((t) => (!sp.worker || t.worker_id === sp.worker) && inProj(t.task_id));

  type Item = { icon: string; c: string; t: React.ReactNode; s: React.ReactNode; at?: string };
  const attn: Item[] = [];
  estimating.forEach((t) => { const e = estMap.get(t.id); if (e) attn.push({ icon: 'clock', c: 'violet', t: <><b>{name(t.assignee_id)}</b> estimates {fmtH(e.hours)}</>, s: <Link className="link" href={`/tasks/${t.id}`}>Review estimate for {code(t.id)} {t.title}</Link>, at: e.created_at }); });
  inReview.forEach((t) => attn.push({ icon: 'review', c: 'violet', t: <><b>{name(t.assignee_id)}</b> submitted work for review</>, s: <TaskLink t={t} />, at: t.updated_at }));
  requests.forEach((r) => { const t = byId.get(r.task_id)!; attn.push({ icon: 'plus', c: 'warn', t: <><b>{name(r.worker_id)}</b> requests {fmtH(r.hours)} more</>, s: <><TaskLink t={t} /> · {r.reason}</>, at: r.created_at }); });
  waiting.forEach(({ q }) => { const t = byId.get(q.task_id)!; attn.push({ icon: 'comment', c: 'violet', t: <><b>{name(q.author_id)}</b> asked a question</>, s: <><Link className="link" href={`/tasks/${t.id}?tab=discussion`}>{code(t.id)} {t.title}</Link> · “{q.body.slice(0, 90)}{q.body.length > 90 ? '…' : ''}”</>, at: q.created_at }); });
  blocked.forEach((t) => attn.push({ icon: 'flag', c: 'bad', t: <><b>Blocked:</b> {t.blocker_text}</>, s: <><TaskLink t={t} /> · {name(t.assignee_id)}</>, at: t.blocker_at ?? undefined }));
  flagged.forEach((e) => { const t = byId.get(e.task_id)!; attn.push({ icon: 'alert', c: 'warn', t: <><b>Flagged session:</b> {name(e.worker_id)} logged {fmtH(hrs(e))}</>, s: <><TaskLink t={t} /> · {e.flag_reason}</>, at: e.created_at }); });
  overdue.forEach((t) => attn.push({ icon: 'calendar', c: 'bad', t: <><b>Overdue</b> since {fmtDay(t.deadline)}</>, s: <><TaskLink t={t} /> · {name(t.assignee_id)}</> }));
  attn.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const workers = team.filter((p) => p.role === 'worker');
  const filtered = sp.worker || sp.project || sp.status || (sp.period && sp.period !== 'month');

  return (
    <>
      <div className="page-head"><h1 style={{ marginRight: 'auto' }}>Dashboard</h1><Link className="btn primary" href="/tasks/new"><Icon name="plus" />New task</Link></div>
      <div className="filters" role="group" aria-label="Dashboard filters">
        <FilterSelect name="worker" label="Worker" value={sp.worker ?? ''} options={[['', 'All workers'], ...workers.map((w) => [w.id, w.full_name || w.email] as [string, string])]} />
        <FilterSelect name="project" label="Project" value={sp.project ?? ''} options={[['', 'All projects'], ...(pdata ?? []).map((p) => [p.id, p.name] as [string, string])]} />
        <FilterSelect name="status" label="Status" value={sp.status ?? ''} options={[['', 'All statuses'], ...STATUSES.map((s) => [s, STATUS_LABEL[s]] as [string, string])]} />
        <FilterSelect name="period" label="Date range" value={sp.period ?? 'month'} options={[['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['all', 'All time']]} />
        {filtered && <Link className="btn ghost sm" href="/">Clear filters</Link>}
      </div>
      <div className="tiles">
        <Tile v={active.length} label="Active tasks" icon="list" href="/tasks" />
        <Tile v={estimating.length} label="Estimates to approve" icon="clock" href="/review?tab=estimates" cls={estimating.length ? 'attn' : ''} />
        <Tile v={overdue.length} label="Overdue" icon="calendar" href="/tasks?status=__overdue" cls={overdue.length ? 'alert' : ''} />
        <Tile v={blocked.length} label="Blocked" icon="flag" href="/tasks?status=blocked" cls={blocked.length ? 'alert' : ''} />
        <Tile v={inReview.length} label="Work awaiting review" icon="review" href="/review?tab=work" cls={inReview.length ? 'attn' : ''} />
        <Tile v={pending.length} label="Time entries to approve" icon="clock" href="/review?tab=time" cls={pending.length ? 'attn' : ''} />
        <Tile v={requests.length} label="Extra-hours requests" icon="plus" href="/review?tab=hours" cls={requests.length ? 'attn' : ''} />
        <Tile v={near.length} label="Near hour limit (80%+)" icon="alert" href="/tasks?status=__near" cls={near.length ? 'attn' : ''} />
        <Tile v={waiting.length} label="Questions to answer" icon="comment" href="/tasks?status=__questions" cls={waiting.length ? 'attn' : ''} />
      </div>
      <section className="card">
        <div className="card-h"><h2>Approved labor cost</h2><span className="muted small">{per ? per.label : 'All time'} · approved hours only, at the rate stored on each entry</span></div>
        {Object.keys(byCur).length ? (
          <div className="cost">
            {Object.entries(byCur).map(([c, v]) => (
              <div key={c}><span className="eyebrow">{c}</span><span className="amt">{money(v.amt, c)}</span><span className="muted small num">{fmtH(v.h)} approved</span></div>
            ))}
          </div>
        ) : <Empty>No approved time in this period yet.</Empty>}
      </section>
      <div className="grid g2">
        <section className="card">
          <div className="card-h"><h2>Needs your attention</h2><span className="muted small">{attn.length} items</span></div>
          <div className="list">
            {attn.length ? attn.slice(0, 12).map((a, i) => (
              <div className="li" key={i}>
                <span className={'li-ic ' + a.c}><Icon name={a.icon} /></span>
                <div className="li-main"><span>{a.t}</span><span className="small muted">{a.s}</span></div>
                {a.at && <span className="small faint">{ago(a.at)}</span>}
              </div>
            )) : <Empty>Nothing needs your attention.</Empty>}
          </div>
        </section>
        <section className="card">
          <div className="card-h"><h2>Tasks approaching their hour limit</h2></div>
          <div className="list">
            {near.length ? near.map((t) => (
              <div className="li" key={t.id}>
                <div className="li-main"><TaskLink t={t} /><span className="small muted">{name(t.assignee_id)}{requests.some((r) => r.task_id === t.id) && <> · <b>extra-hours request pending</b></>}</span></div>
                <div style={{ width: 150 }}><Meter task={t} h={hours.get(t.id)} /></div>
              </div>
            )) : <Empty>No tasks above 80% of their approved hours.</Empty>}
          </div>
          <div className="card-h" style={{ marginTop: 16 }}><h2>Timers running now</h2></div>
          <div className="list">
            {running.length ? running.map((tm) => (
              <div className="li" key={tm.worker_id}>
                <span className="li-ic ok"><Icon name="clock" /></span>
                <div className="li-main"><b>{name(tm.worker_id)}</b><span className="small muted">{byId.get(tm.task_id) && <TaskLink t={byId.get(tm.task_id)!} />}</span></div>
                <Clock since={tm.started_at} />
              </div>
            )) : <Empty>No timers running.</Empty>}
          </div>
        </section>
      </div>
    </>
  );
}

async function WorkerDashboard() {
  const { sb, me, team, settings, name } = await getContext();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const ws = weekStart(today);
  const fromWeek = zonedToISO(ws, '00:00', tz), fromToday = zonedToISO(today, '00:00', tz), toToday = zonedToISO(addDays(today, 1), '00:00', tz);
  const [{ data: tdata }, { data: timer }, { data: edata }, { data: rdata }, { data: estData }] = await Promise.all([
    sb.from('tasks').select('*').eq('assignee_id', me.id),
    sb.from('timers').select('*').eq('worker_id', me.id).maybeSingle(),
    sb.from('time_entries').select('*').eq('worker_id', me.id).gte('ended_at', fromWeek).order('started_at', { ascending: false }),
    sb.from('hour_requests').select('*').eq('worker_id', me.id).order('created_at', { ascending: false }).limit(5),
    sb.from('task_estimates').select('*').eq('worker_id', me.id).order('created_at', { ascending: false }),
  ]);
  const tasks = (tdata ?? []) as Task[];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = tasks.filter((t) => OPEN.includes(t.status));
  const hours = await hoursFor(tasks.map((t) => t.id));
  const tm = timer as Timer | null;
  const entries = (edata ?? []) as Entry[];
  const sumIn = (from: string, to: string) => {
    let h = entries.filter(counted).reduce((s, e) => s + Math.max(0, Math.min(+new Date(e.ended_at), +new Date(to)) - Math.max(+new Date(e.started_at), +new Date(from))) / 3600000, 0);
    if (tm) h += Math.max(0, Math.min(Date.now(), +new Date(to)) - Math.max(+new Date(tm.started_at), +new Date(from))) / 3600000;
    return h;
  };
  const used = (t: Task) => (hours.get(t.id)?.logged ?? 0) + (hours.get(t.id)?.running ?? 0);
  const remaining = (t: Task) => Math.max(0, Number(t.max_hours) - used(t));
  const changes = open.filter((t) => t.status === 'changes_requested');
  const needEst = open.filter((t) => t.status === 'needs_estimate');
  const lastEst = (id: number) => ((estData ?? []) as Estimate[]).find((e) => e.task_id === id);
  const warn = open.filter((t) => Number(t.max_hours) > 0 && used(t) / Number(t.max_hours) >= 0.8);
  const upcoming = open.filter((t) => t.deadline).sort((a, b) => a.deadline!.localeCompare(b.deadline!)).slice(0, 5);
  const ready = open.filter((t) => TRACKABLE.includes(t.status) && remaining(t) > 0);
  const qs = await openQuestions(sb, tasks.map((t) => t.id));
  const roles = new Map(team.map((p) => [p.id, p.role]));
  const forMe = new Set(waitingOn(qs, me, (id) => byId.get(id)?.assignee_id, (id) => roles.get(id)).map((x) => x.q.id));
  const { data: subs } = await sb.from('submissions').select('task_id, comment, decision, created_at').in('task_id', changes.map((t) => t.id).concat(-1)).eq('decision', 'changes').order('created_at', { ascending: false });
  const reqs = (rdata ?? []) as HourRequest[];

  return (
    <>
      <div className="page-head"><h1>My dashboard</h1></div>
      {tm ? (
        <section className="timer-card">
          <div>
            <div className="eyebrow" style={{ color: 'var(--side-muted)' }}>Timer running</div>
            <div className="clock"><Clock since={tm.started_at} /></div>
            <div>{byId.get(tm.task_id) ? `${code(tm.task_id)} · ${byId.get(tm.task_id)!.title}` : code(tm.task_id)}</div>
            <div className="muted small">Started {fmtDT(tm.started_at, tz)}{byId.get(tm.task_id) && <> · {fmtH(remaining(byId.get(tm.task_id)!))} of approved time left</>}</div>
          </div>
          <div className="btn-row">
            <Link className="btn" href={`/tasks/${tm.task_id}`}><Icon name="list" />Open task</Link>
            <StopTimer />
          </div>
        </section>
      ) : (
        <section className="timer-card">
          <div>
            <div className="eyebrow" style={{ color: 'var(--side-muted)' }}>Current timer</div>
            <div className="clock">00:00:00</div>
            <div className="muted">{ready.length ? 'No timer running. Start one from a task:' : 'No tasks are ready for time tracking right now.'}</div>
          </div>
          <div className="btn-row">
            {ready.slice(0, 3).map((t) => <RpcButton key={t.id} fn="start_timer" args={{ p_task: t.id }} label={`Start ${code(t.id)}`} icon="play" variant="primary" success={`Timer started on ${code(t.id)}`} />)}
          </div>
        </section>
      )}
      {needEst.map((t) => (
        <Note key={t.id} kind="warn" icon="clock" action={<Link className="btn sm primary" href={`/tasks/${t.id}`}>Submit estimate</Link>}>
          <b>{code(t.id)} {t.title}</b> needs your time estimate before you can start.
          {lastEst(t.id)?.status === 'revise' && <> Your manager asked for a revision: {lastEst(t.id)!.note}</>}
        </Note>
      ))}
      {warn.map((t) => {
        const over = used(t) >= Number(t.max_hours);
        const pendingReq = reqs.find((r) => r.task_id === t.id && r.status === 'pending');
        return (
          <Note key={'w' + t.id} kind={over ? 'bad' : 'warn'} icon="alert" action={<Link className="btn sm" href={`/tasks/${t.id}`}>Open</Link>}>
            <b>{code(t.id)} {t.title}:</b>{' '}
            {over ? <>all approved hours are used. {pendingReq ? `Your request for ${fmtH(pendingReq.hours)} is waiting for approval.` : 'Request more hours before logging more paid time.'}</>
              : <>{Math.round((used(t) / Number(t.max_hours)) * 100)}% of approved hours used, {fmtH(remaining(t))} left.</>}
          </Note>
        );
      })}
      <div className="tiles">
        <Tile v={fmtH(sumIn(fromToday, toToday))} label="Logged today" icon="clock" />
        <Tile v={fmtH(sumIn(fromWeek, toToday))} label="Logged this week" icon="calendar" />
        <Tile v={fmtH(entries.filter((e) => e.status === 'pending' && counted(e)).reduce((s, e) => s + hrs(e), 0))} label="Waiting for approval (this week)" icon="history" href="/timesheet" />
        <Tile v={changes.length} label="Changes requested" icon="undo" href="/tasks?status=changes_requested" cls={changes.length ? 'attn' : ''} />
      </div>
      <div className="grid g2">
        <section className="card">
          <div className="card-h"><h2>My tasks</h2><Link className="btn sm" href="/tasks">View all</Link></div>
          <div className="list">
            {open.length ? open.map((t) => (
              <div className="li" key={t.id}>
                <div className="li-main"><TaskLink t={t} /><span className="small muted"><StatusPill s={t.status} /> · due {fmtDay(t.deadline)}</span></div>
                <div style={{ width: 150 }}>
                  {Number(t.max_hours) > 0 && <div className="small muted">Remaining: <b className="num">{fmtH(remaining(t))}</b></div>}
                  <Meter task={t} h={hours.get(t.id)} />
                </div>
              </div>
            )) : <Empty>No open tasks.</Empty>}
          </div>
        </section>
        <div className="grid" style={{ alignContent: 'start' }}>
          <section className="card">
            <div className="card-h"><h2>Upcoming deadlines</h2></div>
            <div className="list">
              {upcoming.length ? upcoming.map((t) => (
                <div className="li" key={t.id}>
                  <span className={'li-ic ' + (isOverdue(t, today) ? 'bad' : '')}><Icon name="calendar" /></span>
                  <div className="li-main"><TaskLink t={t} /><span className="small" style={isOverdue(t, today) ? { color: 'var(--bad)', fontWeight: 600 } : { color: 'var(--muted)' }}>{isOverdue(t, today) ? 'Overdue · was due ' : 'Due '}{fmtDay(t.deadline)}</span></div>
                  <Prio p={t.priority} />
                </div>
              )) : <Empty>No upcoming deadlines.</Empty>}
            </div>
          </section>
          <section className="card">
            <div className="card-h"><h2>Questions & clarifications</h2></div>
            <div className="list">
              {qs.length ? qs.map(({ q, answered }) => {
                const t = byId.get(q.task_id); if (!t) return null;
                const mine = forMe.has(q.id);
                return (
                  <div className="li" key={q.id}>
                    <span className={'li-ic ' + (mine ? 'warn' : 'violet')}><Icon name="comment" /></span>
                    <div className="li-main"><Link className="link" href={`/tasks/${t.id}?tab=discussion`}>{code(t.id)} {t.title}</Link><span className="small">{q.author_id === me.id ? 'You asked' : name(q.author_id) + ' asked'}: “{q.body.slice(0, 100)}{q.body.length > 100 ? '…' : ''}”</span></div>
                    {mine ? <span className="pill e-pending">Needs your answer</span> : answered ? <span className="pill s-prog">Answered</span> : <span className="pill e-pending">Waiting for answer</span>}
                  </div>
                );
              }) : <Empty>No open questions. If anything about a task is unclear, open it and choose Ask a question.</Empty>}
            </div>
          </section>
          <section className="card">
            <div className="card-h"><h2>Changes requested</h2></div>
            <div className="list">
              {changes.length ? changes.map((t) => (
                <div className="li" key={t.id}>
                  <span className="li-ic warn"><Icon name="undo" /></span>
                  <div className="li-main"><TaskLink t={t} /><span className="small">{(subs ?? []).find((s) => s.task_id === t.id)?.comment}</span></div>
                </div>
              )) : <Empty>No changes requested.</Empty>}
            </div>
          </section>
        </div>
      </div>
      <div className="grid g2">
        <section className="card">
          <div className="card-h"><h2>My timesheet this week</h2><Link className="btn sm" href="/timesheet">Full timesheet</Link></div>
          <EntryTable entries={entries} tz={tz} tasks={byId} compact />
        </section>
        <section className="card">
          <div className="card-h"><h2>My additional-hours requests</h2><Link className="btn sm" href="/requests">All requests</Link></div>
          <div className="list">
            {reqs.length ? reqs.map((r) => <RequestRow key={r.id} r={r} task={byId.get(r.task_id)} tz={tz} name={name} />)
              : <Empty>No requests yet. When a task needs more time than approved, request it from the task.</Empty>}
          </div>
        </section>
      </div>
    </>
  );
}

