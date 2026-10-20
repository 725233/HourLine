import Link from 'next/link';
import { requireManager } from '@/lib/context';
import { todayIn } from '@/lib/format';
import { addDays } from '@/lib/period';
import { TaskForm } from '@/components/TaskForm';

export const metadata = { title: 'New task' };

export default async function NewTask() {
  const { sb, team, settings } = await requireManager();
  const { data: projects } = await sb.from('projects').select('id, name').eq('archived', false).order('name');
  const workers = team.filter((p) => p.role === 'worker' && p.active).map((p) => ({ id: p.id, name: p.full_name || p.email }));
  return (
    <>
      <Link className="back" href="/tasks">← Tasks</Link>
      <div className="page-head"><h1>New task</h1></div>
      <TaskForm projects={projects ?? []} workers={workers} defaultDeadline={addDays(todayIn(settings.timezone), 7)} />
    </>
  );
}
