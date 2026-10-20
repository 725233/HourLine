import Link from 'next/link';
import { requireManager } from '@/lib/context';
import { code, fmtDT } from '@/lib/format';
import { Empty } from '@/components/ui';
import { FilterSelect } from '@/components/client';
import type { Activity } from '@/lib/types';

export const metadata = { title: 'Activity history' };

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ who?: string }> }) {
  const sp = await searchParams;
  const { sb, team, settings, name } = await requireManager();
  let q = sb.from('activity').select('*').order('created_at', { ascending: false }).limit(300);
  if (sp.who) q = q.eq('actor_id', sp.who);
  const { data } = await q;
  const list = (data ?? []) as Activity[];
  return (
    <>
      <div className="page-head"><h1>Activity history</h1></div>
      <div className="filters">
        <FilterSelect name="who" label="Person" value={sp.who ?? ''} options={[['', 'Everyone'], ...team.map((p) => [p.id, p.full_name || p.email] as [string, string])]} />
        <span className="small muted">Every change to assignments, deadlines, approved hours, statuses, time entries, rates and payments. This log can’t be edited or deleted.</span>
      </div>
      <section className="card">
        {list.length ? list.map((a) => (
          <div className="act" key={a.id}>
            <time>{fmtDT(a.created_at, settings.timezone)}</time>
            <div><b>{name(a.actor_id)}</b> {a.body}{a.task_id && <> · <Link className="link" href={`/tasks/${a.task_id}?tab=activity`}>{code(a.task_id)}</Link></>}</div>
          </div>
        )) : <Empty>No activity yet.</Empty>}
      </section>
    </>
  );
}
