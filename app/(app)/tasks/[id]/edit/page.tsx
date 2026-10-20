import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireManager } from '@/lib/context';
import { code, todayIn } from '@/lib/format';
import { TaskForm } from '@/components/TaskForm';
import type { Task } from '@/lib/types';

export const metadata = { title: 'Edit task' };

export default async function EditTask({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sb, team, settings } = await requireManager();
  const [{ data: task }, { data: projects }] = await Promise.all([
    sb.from('tasks').select('*').eq('id', Number(id)).maybeSingle(),
    sb.from('projects').select('id, name').order('name'),
  ]);
  if (!task) notFound();
  const workers = team.filter((p) => p.role === 'worker' && p.active).map((p) => ({ id: p.id, name: p.full_name || p.email }));
  return (
    <>
      <Link className="back" href={`/tasks/${id}`}>← {code(Number(id))}</Link>
      <div className="page-head"><h1>Edit {code(Number(id))}</h1></div>
      <TaskForm projects={projects ?? []} workers={workers} task={task as Task} defaultDeadline={todayIn(settings.timezone)} />
    </>
  );
}
