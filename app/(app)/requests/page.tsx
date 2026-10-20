import { getContext } from '@/lib/context';
import { EntryTable } from '@/components/EntryTable';
import { RequestRow } from '@/components/shared';
import { Empty } from '@/components/ui';
import type { Entry, HourRequest, Task } from '@/lib/types';

export const metadata = { title: 'My requests' };

export default async function Requests() {
  const { sb, me, settings, name } = await getContext();
  const [{ data: rdata }, { data: edata }, { data: tdata }] = await Promise.all([
    sb.from('hour_requests').select('*').eq('worker_id', me.id).order('created_at', { ascending: false }),
    sb.from('time_entries').select('*').eq('worker_id', me.id).neq('kind', 'timer').order('created_at', { ascending: false }),
    sb.from('tasks').select('id, title').eq('assignee_id', me.id),
  ]);
  const tasks = new Map(((tdata ?? []) as Task[]).map((t) => [t.id, t]));
  const reqs = (rdata ?? []) as HourRequest[];
  return (
    <>
      <div className="page-head"><h1>My requests</h1></div>
      <section className="card">
        <div className="card-h"><h2>Additional-hours requests</h2></div>
        <div className="list">{reqs.length ? reqs.map((r) => <RequestRow key={r.id} r={r} task={tasks.get(r.task_id)} tz={settings.timezone} name={name} />) : <Empty>No requests yet. Open a task and choose Request more hours.</Empty>}</div>
      </section>
      <section className="card">
        <div className="card-h"><h2>Manual entries and corrections</h2></div>
        <EntryTable entries={(edata ?? []) as Entry[]} tz={settings.timezone} tasks={tasks} showTask showPay actions="worker" />
      </section>
    </>
  );
}
