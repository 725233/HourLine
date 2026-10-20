import { counted, fmtDate, fmtH, fmtTime, hrs, money } from '@/lib/format';
import type { Entry, Task } from '@/lib/types';
import { EntryPill, Flags, KindTag, TaskLink } from './ui';
import { RpcButton, RpcDialog } from './client';
import { ymdInTz } from '@/lib/format';

interface Props {
  entries: Entry[];
  tz: string;
  tasks?: Map<number, Pick<Task, 'id' | 'title'>>;
  name?: (id: string) => string;
  showWorker?: boolean;
  showTask?: boolean;
  showPay?: boolean;
  compact?: boolean;
  /** 'manager' shows approve/reject; 'worker' shows correction and summary actions. */
  actions?: 'manager' | 'worker';
  /** All entries for this worker or task, used to detect pending corrections. */
  related?: Entry[];
}

export function EntryTable({ entries, tz, tasks, name, showWorker, showTask, showPay, compact, actions, related }: Props) {
  if (!entries.length) return <p className="empty">No time entries.</p>;
  const all = related ?? entries;
  return (
    <div className="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            {showWorker && <th>Worker</th>}
            {showTask && <th>Task</th>}
            <th>Time</th>
            <th className="r">Hours</th>
            {!compact && <th>Summary</th>}
            <th>Status</th>
            {showPay && !compact && <><th className="r">Rate</th><th className="r">Pay</th></>}
            {actions && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const orig = e.corrects_id ? all.find((x) => x.id === e.corrects_id) : undefined;
            const t = tasks?.get(e.task_id);
            return (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}><div>{fmtDate(e.started_at, tz)}</div><div className="tid">#{e.id}</div></td>
                {showWorker && <td style={{ whiteSpace: 'nowrap' }}>{name?.(e.worker_id)}</td>}
                {showTask && <td style={{ minWidth: 160 }}>{t ? <TaskLink t={t} /> : 'T-' + e.task_id}</td>}
                <td style={{ whiteSpace: 'nowrap' }} className="num">{fmtTime(e.started_at, tz)}–{fmtTime(e.ended_at, tz)}<div><KindTag e={e} /></div></td>
                <td className="r num">{fmtH(hrs(e))}</td>
                {!compact && (
                  <td style={{ minWidth: 200 }}>
                    {e.summary}
                    {e.needs_summary && <> <span className="flag">Summary needed</span></>}
                    {e.reason && <div className="small muted"><b>Reason:</b> {e.reason}</div>}
                    {orig && <div className="small muted">Changes #{orig.id} from {fmtTime(orig.started_at, tz)}–{fmtTime(orig.ended_at, tz)} ({fmtH(hrs(orig))})</div>}
                    {e.decision_note && <div className="small"><b>Manager:</b> {e.decision_note}</div>}
                    <div><Flags e={e} /></div>
                  </td>
                )}
                <td><EntryPill e={e} />{e.payment_id && <div className="small muted">Payment #{e.payment_id}</div>}</td>
                {showPay && !compact && (
                  <>
                    <td className="r num">{money(e.rate, e.currency)}/h</td>
                    <td className="r num">{e.status === 'approved' && counted(e) ? money(hrs(e) * Number(e.rate), e.currency) : '—'}</td>
                  </>
                )}
                {actions && <td><div className="btn-row">{entryActions(e, actions, all, tz)}</div></td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function entryActions(e: Entry, who: 'manager' | 'worker', all: Entry[], tz: string) {
  const out: React.ReactNode[] = [];
  if (who === 'manager' && e.status === 'pending') {
    out.push(<RpcButton key="a" small variant="primary" icon="check" label="Approve" fn="decide_entry" args={{ p_entry: e.id, p_approve: true, p_note: '' }} success={`Approved entry #${e.id}`} />);
    out.push(
      <RpcDialog key="r" small icon="x" label="Reject" title={`Reject time entry #${e.id}`} fn="decide_entry"
        intro={<p className="muted">The entry stays in the record marked Rejected and is not paid.</p>}
        fields={[{ name: 'note', label: 'Reason (the worker sees this)', type: 'textarea', required: true, minLength: 3 }]}
        args={{ p_entry: e.id, p_approve: false, p_note: { field: 'note' } }} submitLabel="Reject entry" danger />,
    );
  }
  if (who === 'worker') {
    if (e.needs_summary) {
      out.push(
        <RpcDialog key="s" small label="Add summary" title="Add work summary" fn="add_entry_summary"
          intro={<p className="muted">This timer was stopped automatically. Add a summary of the work. The logged time does not change.</p>}
          fields={[{ name: 'summary', label: 'Summary', type: 'textarea', required: true, minLength: 10 }]}
          args={{ p_entry: e.id, p_summary: { field: 'summary' } }} submitLabel="Save summary" />,
      );
    }
    const pendingCorr = all.some((x) => x.corrects_id === e.id && x.status === 'pending');
    if (pendingCorr) out.push(<span key="p" className="small muted">Correction pending</span>);
    else if (e.status !== 'rejected' && !e.superseded_by && !e.payment_id && e.kind !== 'correction') {
      out.push(
        <RpcDialog key="c" small icon="edit" label="Request correction" title={`Request correction for #${e.id}`} fn="request_correction" tz={tz}
          intro={<p className="muted">Currently {fmtDate(e.started_at, tz)}, {fmtTime(e.started_at, tz)}–{fmtTime(e.ended_at, tz)} ({fmtH(hrs(e))}). The original entry is kept. If approved, the corrected time replaces it for pay.</p>}
          fields={[
            { name: 'date', label: 'Date', type: 'date', required: true, defaultValue: ymdInTz(new Date(e.started_at), tz) },
            { name: 'start', label: 'Start', type: 'time', required: true, defaultValue: fmtTime(e.started_at, tz) },
            { name: 'end', label: 'End', type: 'time', required: true, defaultValue: fmtTime(e.ended_at, tz) },
            { name: 'reason', label: 'Reason for correction', required: true, minLength: 5, placeholder: 'For example: Left the timer running during lunch' },
          ]}
          args={{ p_entry: e.id, p_start: { field: 'date', as: 'datetime', time: 'start' }, p_end: { field: 'date', as: 'datetime', time: 'end' }, p_reason: { field: 'reason' } }}
          submitLabel="Submit correction" success="Correction sent for approval. The original is unchanged until then." />,
      );
    }
  }
  return out.length ? out : <span className="faint small">—</span>;
}
