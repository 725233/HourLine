import Link from 'next/link';
import { getContext, hoursFor } from '@/lib/context';
import { OPEN, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, code, fmtDay, fmtH, isOverdue, todayIn } from '@/lib/format';
import { openQuestions, waitingOn } from '@/lib/questions';
import { Icon } from '@/components/Icon';
import { Meter, Prio, QFlag, StatusPill } from '@/components/ui';
import { FilterSelect, SearchBox } from '@/components/client';
import type { Task } from '@/lib/types';

export const metadata = { title: 'Tasks' };
type SP = Promise<{ q?: string; project?: string; worker?: string; status?: string; priority?: string; view?: string }>;

export default async function TasksPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { sb, me, isManager, team, settings, name } = await getContext();
  const today = todayIn(settings.timezone);
  const [{ data: tdata }, { data: pdata }] = await Promise.all([
    isManager ? sb.from('tasks').select('*') : sb.from('tasks').select('*').eq('assignee_id', me.id),
    sb.from('projects').select('*').order('name'),
  ]);
  const all = (tdata ?? []) as Task[];
  const hours = await hoursFor(all.map((t) => t.id));
  const qs = await openQuestions(sb, all.map((t) => t.id));
  const byId = new Map(all.map((t) => [t.id, t]));
  const roles = new Map(team.map((p) => [p.id, p.role]));
  const waiting = waitingOn(qs, me, (id) => byId.get(id)?.assignee_id, (id) => roles.get(id));
  const openQ = (id: number) => qs.filter((x) => x.q.task_id === id).length;
  const forMe = (id: number) => waiting.filter((x) => x.q.task_id === id).length;
  const projects = new Map((pdata ?? []).map((p) => [p.id, p.name as string]));
  const pct = (t: Task) => (Number(t.max_hours) > 0 ? ((hours.get(t.id)?.logged ?? 0) + (hours.get(t.id)?.running ?? 0)) / Number(t.max_hours) : 0);
  const q = (sp.q ?? '').toLowerCase();
  const list = all.filter((t) =>
    (!sp.project || t.project_id === sp.project) && (!sp.worker || t.assignee_id === sp.worker) && (!sp.priority || t.priority === sp.priority) &&
    (!sp.status || (sp.status === '__overdue' ? isOverdue(t, today) : sp.status === '__near' ? OPEN.includes(t.status) && pct(t) >= 0.8
      : sp.status === '__questions' ? openQ(t.id) > 0 : t.status === sp.status)) &&
    (!q || `${code(t.id)} ${t.title} ${t.description}`.toLowerCase().includes(q)));
  const pr = { urgent: 0, high: 1, medium: 2, low: 3 };
  list.sort((a, b) => Number(OPEN.includes(b.status)) - Number(OPEN.includes(a.status)) || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || pr[a.priority] - pr[b.priority]);
  const view = sp.view === 'kanban' ? 'kanban' : 'table';
  const viewHref = (v: string) => { const p = new URLSearchParams(sp as Record<string, string>); p.set('view', v); return '/tasks?' + p; };
  const running = (t: Task) => !!hours.get(t.id)?.running_since;

  return (
    <>
      <div className="page-head"><h1 style={{ marginRight: 'auto' }}>{isManager ? 'Tasks' : 'My tasks'}</h1>{isManager && <Link className="btn primary" href="/tasks/new"><Icon name="plus" />New task</Link>}</div>
      <div className="filters">
        <SearchBox value={sp.q ?? ''} />
        <FilterSelect name="project" label="Project" value={sp.project ?? ''} options={[['', 'All projects'], ...[...projects].map(([id, n]) => [id, n] as [string, string])]} />
        {isManager && <FilterSelect name="worker" label="Worker" value={sp.worker ?? ''} options={[['', 'All workers'], ...team.filter((p) => p.role === 'worker').map((w) => [w.id, w.full_name || w.email] as [string, string])]} />}
        <FilterSelect name="status" label="Status" value={sp.status ?? ''} options={[['', 'All statuses'], ...STATUSES.map((s) => [s, STATUS_LABEL[s]] as [string, string]), ['__overdue', 'Overdue'], ['__near', 'Near hour limit'], ['__questions', 'Has open questions']]} />
        <FilterSelect name="priority" label="Priority" value={sp.priority ?? ''} options={[['', 'All priorities'], ...PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]] as [string, string])]} />
        <span className="seg" role="group" aria-label="Layout">
          <Link href={viewHref('table')} aria-pressed={view === 'table'} className="segl" style={segStyle(view === 'table')}><Icon name="list" />Table</Link>
          <Link href={viewHref('kanban')} aria-pressed={view === 'kanban'} className="segl" style={segStyle(view === 'kanban')}><Icon name="board" />Kanban</Link>
        </span>
      </div>
      {view === 'kanban' ? (
        <div className="kanban">
          {STATUSES.map((s) => {
            const ts = list.filter((t) => t.status === s);
            return (
              <div className="col" key={s}>
                <div className="col-h"><StatusPill s={s} /><span className="small muted num">{ts.length}</span></div>
                {ts.map((t) => (
                  <Link className="kcard" key={t.id} href={`/tasks/${t.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                    <span className="tid">{code(t.id)} · {projects.get(t.project_id)}</span>
                    <span className="ttl">{t.title}</span>
                    <span className="kmeta"><Prio p={t.priority} /><span>{isOverdue(t, today) ? <b style={{ color: 'var(--bad)' }}>Overdue {fmtDay(t.deadline)}</b> : fmtDay(t.deadline)}</span>{isManager && <span>{name(t.assignee_id)}</span>}</span>
                    {s !== 'cancelled' && <Meter task={t} h={hours.get(t.id)} />}
                    {running(t) && <span className="small" style={{ color: 'var(--ok)', fontWeight: 600 }}>● Timer running</span>}
                    <QFlag open={openQ(t.id)} forMe={forMe(t.id)} />
                  </Link>
                ))}
                {!ts.length && <p className="small faint" style={{ padding: 6 }}>No tasks</p>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Task</th><th>Project</th>{isManager && <th>Assigned to</th>}<th>Priority</th><th>Deadline</th><th>Hours used / approved</th><th className="r">Est.</th><th>Status</th></tr></thead>
            <tbody>
              {list.length ? list.map((t) => (
                <tr key={t.id}>
                  <td><div className="tid">{code(t.id)}</div><Link className="ttl link" href={`/tasks/${t.id}`} style={{ color: 'var(--ink)' }}>{t.title}</Link>
                    {running(t) && <div className="small" style={{ color: 'var(--ok)', fontWeight: 600 }}>● Timer running</div>}
                    <QFlag open={openQ(t.id)} forMe={forMe(t.id)} /></td>
                  <td>{projects.get(t.project_id)}</td>
                  {isManager && <td>{name(t.assignee_id)}</td>}
                  <td><Prio p={t.priority} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{isOverdue(t, today) ? <b style={{ color: 'var(--bad)' }}>{fmtDay(t.deadline)}<br /><span className="small">Overdue</span></b> : fmtDay(t.deadline)}</td>
                  <td style={{ minWidth: 150 }}><Meter task={t} h={hours.get(t.id)} /></td>
                  <td className="r num">{Number(t.est_hours) > 0 ? fmtH(t.est_hours) : '—'}</td>
                  <td><StatusPill s={t.status} /></td>
                </tr>
              )) : <tr><td colSpan={8} className="empty">No tasks match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const segStyle = (on: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 11px', fontSize: 13, textDecoration: 'none',
  background: on ? 'var(--accent)' : 'var(--surface)', color: on ? 'var(--accent-ink)' : 'var(--ink)',
});
