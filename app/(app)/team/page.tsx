import { requireManager } from '@/lib/context';
import { CURRENCIES, OPEN, PROJECT_KINDS, counted, fmtDay, fmtH, hrs, money, todayIn } from '@/lib/format';
import { period } from '@/lib/period';
import { RpcDialog } from '@/components/client';
import { InviteButton } from '@/components/InviteForm';
import { Note } from '@/components/ui';
import type { Entry, Rate, Task } from '@/lib/types';

export const metadata = { title: 'Team & projects' };

const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default async function Team() {
  const { sb, team, settings, me } = await requireManager();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const month = period('month', today, tz);
  const [{ data: rdata }, { data: tdata }, { data: pdata }, { data: edata }] = await Promise.all([
    sb.from('worker_rates').select('*').order('effective_from', { ascending: false }),
    sb.from('tasks').select('id, project_id, assignee_id, status'),
    sb.from('projects').select('*').order('name'),
    sb.from('time_entries').select('worker_id, task_id, started_at, ended_at, status, superseded_by, kind').gte('started_at', month.from).lt('started_at', month.to),
  ]);
  const rates = (rdata ?? []) as Rate[];
  const tasks = (tdata ?? []) as Pick<Task, 'id' | 'project_id' | 'assignee_id' | 'status'>[];
  const entries = (edata ?? []) as Entry[];
  const workers = team.filter((p) => p.role === 'worker');
  const managers = team.filter((p) => p.role === 'manager');
  const current = (id: string) => rates.find((r) => r.worker_id === id && r.effective_from <= today);
  const upcoming = (id: string) => rates.filter((r) => r.worker_id === id && r.effective_from > today);

  const editPerson = (p: (typeof team)[number]) => (
    <RpcDialog small label="Edit" icon="edit" title={`Edit ${p.full_name || p.email}`} fn="update_profile"
      fields={[
        { name: 'name', label: 'Full name', required: true, defaultValue: p.full_name },
        { name: 'title', label: 'Role or title', defaultValue: p.title },
        { name: 'role', label: 'Access', type: 'select', options: [['worker', 'Worker'], ['manager', 'Manager']], defaultValue: p.role },
        { name: 'active', label: 'Status', type: 'select', options: [['true', 'Active'], ['false', 'Deactivated (can’t sign in or see data)']], defaultValue: String(p.active) },
      ]}
      args={{ p_user: p.id, p_full_name: { field: 'name' }, p_title: { field: 'title' }, p_role: { field: 'role' }, p_active: { field: 'active', as: 'bool' } }}
      submitLabel="Save" success="Saved." />
  );

  return (
    <>
      <div className="page-head"><h1>Team &amp; projects</h1></div>
      <section className="card">
        <div className="card-h"><h2>Workers</h2><InviteButton /></div>
        {workers.length ? (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Name</th><th>Role</th><th className="r">Hourly rate</th><th>Rate history</th><th className="r">Open tasks</th><th className="r">Approved this month</th><th>Actions</th></tr></thead>
              <tbody>
                {workers.map((w) => {
                  const r = current(w.id);
                  const hist = rates.filter((x) => x.worker_id === w.id);
                  return (
                    <tr key={w.id} style={w.active ? undefined : { opacity: 0.6 }}>
                      <td><b>{w.full_name || w.email}</b><div className="small muted">{w.email}{!w.active && ' · deactivated'}</div></td>
                      <td>{w.title}</td>
                      <td className="r num">{r ? <><b>{money(r.rate, r.currency)}</b>/h</> : <span className="pill e-pending">Not set</span>}</td>
                      <td className="small">{hist.length ? hist.map((x) => <div key={x.id} className="num">{money(x.rate, x.currency)} from {x.effective_from <= '2000-01-01' || hist[hist.length - 1].id === x.id ? 'start' : fmtDay(x.effective_from)}{x.effective_from > today && ' (upcoming)'}</div>) : '—'}</td>
                      <td className="r num">{tasks.filter((t) => t.assignee_id === w.id && OPEN.includes(t.status)).length}</td>
                      <td className="r num">{fmtH(entries.filter((e) => e.worker_id === w.id && counted(e) && e.status === 'approved').reduce((s, e) => s + hrs(e), 0))}</td>
                      <td><div className="btn-row">
                        <RpcDialog small icon="money" label={r ? 'Change rate' : 'Set rate'} title={`${r ? 'Change' : 'Set'} rate for ${w.full_name || w.email}`} fn="set_rate"
                          intro={<p className="muted">{r ? <>Current rate: <b>{money(r.rate, r.currency)}/h</b>. The new rate applies to time logged from the start date. Entries already logged keep the rate they were logged at.</> : 'This first rate applies to all of their time.'}{upcoming(w.id).length > 0 && ' An upcoming change on the same date is replaced.'}</p>}
                          fields={[
                            { name: 'rate', label: 'Hourly rate', type: 'number', required: true, min: 0.5, step: 0.5, defaultValue: r ? String(r.rate) : '' },
                            { name: 'currency', label: 'Currency', type: 'select', options: CURRENCIES.map((c) => [c, c] as [string, string]), defaultValue: r?.currency ?? 'USD' },
                            ...(r ? [{ name: 'from', label: 'Starts on', type: 'date' as const, required: true, min: today, defaultValue: today }] : []),
                          ]}
                          args={{ p_worker: w.id, p_rate: { field: 'rate', as: 'number' }, p_currency: { field: 'currency' }, p_from: r ? { field: 'from' } : null }}
                          submitLabel="Save rate" success="Rate saved." />
                        {editPerson(w)}
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Note kind="info">No workers yet. Use Invite person to add your team. They’ll get an email with a sign-in link.</Note>}
        <p className="small muted" style={{ marginTop: 8 }}>Workers only see their own rate and pay. A new rate applies from its start date; earlier entries keep their original rate.</p>
      </section>

      <section className="card">
        <div className="card-h"><h2>Projects</h2>
          <RpcDialog small variant="primary" icon="plus" label="Add project" title="Add project" fn="create_project"
            fields={[{ name: 'name', label: 'Project name', required: true }, { name: 'kind', label: 'Type', type: 'select', options: PROJECT_KINDS.map((k) => [k, k] as [string, string]) }]}
            args={{ p_name: { field: 'name' }, p_kind: { field: 'kind' } }} submitLabel="Add project" success="Project added." />
        </div>
        {(pdata ?? []).length ? (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Project</th><th>Type</th><th className="r">Open tasks</th><th className="r">Completed</th></tr></thead>
            <tbody>{(pdata ?? []).map((p) => (
              <tr key={p.id}><td><b>{p.name}</b></td><td>{p.kind}</td>
                <td className="r num">{tasks.filter((t) => t.project_id === p.id && OPEN.includes(t.status)).length}</td>
                <td className="r num">{tasks.filter((t) => t.project_id === p.id && t.status === 'completed').length}</td></tr>
            ))}</tbody>
          </table></div>
        ) : <Note kind="info">Add a project before creating tasks.</Note>}
      </section>

      <section className="card">
        <div className="card-h"><h2>Managers</h2></div>
        <div className="list">
          {managers.map((m) => (
            <div className="li" key={m.id}><div className="li-main"><b>{m.full_name || m.email}{m.id === me.id && ' (you)'}</b><span className="small muted">{m.email} · {m.title || 'Manager'}{!m.active && ' · deactivated'}</span></div>{editPerson(m)}</div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-h"><h2>Settings</h2>
          <RpcDialog small icon="edit" label="Edit settings" title="Settings" fn="update_settings"
            fields={[
              { name: 'org', label: 'Organisation name', defaultValue: settings.org_name },
              { name: 'tz', label: 'Time zone for times, days and pay periods', type: 'select', options: TIMEZONES.map((z) => [z, z] as [string, string]), defaultValue: settings.timezone },
            ]}
            args={{ p_org_name: { field: 'org' }, p_timezone: { field: 'tz' } }} submitLabel="Save settings" success="Settings saved." />
        </div>
        <dl className="kv">
          <div><dt>Organisation</dt><dd>{settings.org_name}</dd></div>
          <div><dt>Time zone</dt><dd>{settings.timezone}</dd></div>
          <div><dt>Hour-limit warning</dt><dd>{Math.round(Number(settings.warn_ratio) * 100)}%</dd></div>
          <div><dt>Long session flag</dt><dd>Over {Number(settings.long_session_hours)} h</dd></div>
          <div><dt>Email notifications</dt><dd>Sign-in emails only. Activity emails are a future integration.</dd></div>
        </dl>
      </section>
    </>
  );
}
