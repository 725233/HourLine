'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { PRIORITIES, PRIORITY_LABEL } from '@/lib/format';
import type { Task } from '@/lib/types';
import { FilePicker, MAX_FILE, toast, uploadFiles } from './client';

interface Props {
  projects: { id: string; name: string }[];
  workers: { id: string; name: string }[];
  task?: Task;
  defaultDeadline: string;
}

export function TaskForm({ projects, workers, task, defaultDeadline }: Props) {
  const router = useRouter();
  const editing = !!task;
  const estimateStage = editing && (task.status === 'needs_estimate' || task.status === 'estimate_submitted');
  const [v, setV] = useState({
    title: task?.title ?? '', project: task?.project_id ?? projects[0]?.id ?? '', assignee: task?.assignee_id ?? workers[0]?.id ?? '',
    priority: task?.priority ?? 'medium', deadline: task?.deadline ?? defaultDeadline,
    mode: 'worker', est: String(task?.est_hours || 4), max: String(task?.max_hours || 5),
    description: task?.description ?? '', deliverable: task?.deliverable ?? '', criteria: task?.criteria.join('\n') ?? '', links: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const showHours = editing ? !estimateStage : v.mode === 'set';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (!projects.length) return setErr('Create a project first on the Team & projects page.');
    if (!workers.length) return setErr('Invite a worker first on the Team & projects page.');
    if (files.some((f) => f.size > MAX_FILE)) return setErr('Each file must be 10 MB or smaller.');
    const links = v.links.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const p = l.split('|'); const url = (p[1] ?? p[0]).trim(); return { label: (p[1] ? p[0] : url).trim(), url };
    });
    if (links.some((l) => !/^https?:\/\//i.test(l.url))) return setErr('Links must start with http:// or https://');
    const sb = createClient();
    setBusy(true);
    const common = {
      p_project: v.project, p_title: v.title, p_description: v.description, p_deliverable: v.deliverable,
      p_criteria: v.criteria.split('\n'), p_assignee: v.assignee, p_priority: v.priority, p_deadline: v.deadline || null,
    };
    if (editing) {
      const { error } = await sb.rpc('update_task', { p_task: task.id, ...common, p_est: showHours ? Number(v.est) : null, p_max: showHours ? Number(v.max) : null });
      setBusy(false);
      if (error) return setErr(error.message);
      toast('Saved changes');
      router.push(`/tasks/${task.id}`);
      router.refresh();
      return;
    }
    const { data, error } = await sb.rpc('create_task', {
      ...common, p_ask_estimate: v.mode === 'worker', p_est: Number(v.est) || 0, p_max: Number(v.max) || 0,
    });
    if (error) { setBusy(false); return setErr(error.message); }
    const id = Number(data);
    for (const l of links) await sb.rpc('add_link', { p_task: id, p_label: l.label, p_url: l.url });
    if (files.length) await uploadFiles(id, files);
    setBusy(false);
    const w = workers.find((x) => x.id === v.assignee)?.name ?? 'The worker';
    toast(`Created T-${id}.` + (v.mode === 'worker' ? ` ${w} has been asked for a time estimate.` : ''));
    router.push(`/tasks/${id}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 }}>
      <label className="fld"><span>Task title</span><input value={v.title} onChange={set('title')} required /></label>
      <div className="row2">
        <label className="fld"><span>Project</span><select value={v.project} onChange={set('project')}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="fld"><span>Assigned worker</span><select value={v.assignee} onChange={set('assignee')}>{workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      </div>
      <div className="row2">
        <label className="fld"><span>Priority</span><select value={v.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></label>
        <label className="fld"><span>Deadline</span><input type="date" value={v.deadline} onChange={set('deadline')} /></label>
      </div>
      {!editing && (
        <label className="fld"><span>Hours for this task</span>
          <select value={v.mode} onChange={set('mode')}>
            <option value="worker">Ask the worker to estimate, then I approve (recommended)</option>
            <option value="set">I’ll set the hours myself</option>
          </select>
          <small>The worker submits the hours they need with a short breakdown. Work starts after you approve.</small>
        </label>
      )}
      {estimateStage && <p className="small muted">Hours come from the worker’s estimate, which you approve on the task.</p>}
      {showHours && (
        <div className="row2">
          <label className="fld"><span>Estimated hours</span><input type="number" min="0.25" step="0.25" value={v.est} onChange={set('est')} required /></label>
          <label className="fld"><span>Maximum approved hours</span><input type="number" min="0.25" step="0.25" value={v.max} onChange={set('max')} required /><small>Paid time stops at this limit</small></label>
        </div>
      )}
      <label className="fld"><span>Description</span><textarea value={v.description} onChange={set('description')} /></label>
      <label className="fld"><span>Expected deliverable</span><textarea value={v.deliverable} onChange={set('deliverable')} required placeholder="What exactly should be handed in?" /></label>
      <label className="fld"><span>Acceptance criteria (one per line)</span><textarea value={v.criteria} onChange={set('criteria')} required placeholder="Each line becomes a checkbox the worker ticks when submitting" /></label>
      {!editing && (
        <>
          <div className="fld"><label htmlFor="tf-files" style={{ fontSize: 12.5, fontWeight: 600 }}>Files, images and references (optional)</label><FilePicker id="tf-files" files={files} onChange={setFiles} /></div>
          <label className="fld"><span>Links (optional, one per line)</span><textarea style={{ minHeight: 56 }} value={v.links} onChange={set('links')} placeholder="Design file | https://figma.com/..." /><small>Put an optional label before a |</small></label>
        </>
      )}
      {err && <p className="form-err" role="alert">{err}</p>}
      <div className="modal-f">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy}>{busy && <span className="spinner" />}{editing ? 'Save changes' : 'Create task'}</button>
      </div>
    </form>
  );
}
