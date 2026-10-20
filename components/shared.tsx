import { Icon } from './Icon';
import { TaskLink } from './ui';
import { RpcDialog } from './client';
import { code, fmtDT, fmtH } from '@/lib/format';
import type { HourRequest, Task } from '@/lib/types';

export function RequestRow({ r, task, tz, name }: { r: HourRequest; task?: Pick<Task, 'id' | 'title'>; tz: string; name: (id: string | null) => string }) {
  const pill = r.status === 'pending' ? <span className="pill e-pending">Pending</span> : r.status === 'approved' ? <span className="pill e-approved">Approved</span> : <span className="pill e-rejected">Rejected</span>;
  return (
    <div className="li">
      <span className="li-ic warn"><Icon name="plus" /></span>
      <div className="li-main">
        <span><b className="num">+{fmtH(r.hours)}</b> on {task ? <TaskLink t={task} /> : code(r.task_id)}</span>
        <span className="small muted">{r.reason}</span>
        {r.note && <span className="small"><b>Manager note:</b> {r.note}</span>}
        <span className="small faint">Requested {fmtDT(r.created_at, tz)}{r.decided_at && <> · decided {fmtDT(r.decided_at, tz)} by {name(r.decided_by)}</>}</span>
      </div>
      {pill}
    </div>
  );
}

export function StopTimer() {
  return (
    <RpcDialog label="Stop timer" icon="stop" variant="danger" title="Stop timer" fn="stop_timer"
      fields={[{ name: 'summary', label: 'What did you work on?', type: 'textarea', required: true, minLength: 10, placeholder: 'For example: Finished the FAQ accordion and fixed spacing at 768px', hint: 'At least 10 characters. Your manager sees this when approving time.' }]}
      args={{ p_summary: { field: 'summary' } }} submitLabel="Stop and save" danger success="Time saved. Waiting for approval." />
  );
}
