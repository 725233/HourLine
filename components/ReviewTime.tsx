'use client';
import Link from 'next/link';
import { useState } from 'react';
import { fmtDate, fmtH, fmtTime, hrs, money } from '@/lib/format';
import type { Entry } from '@/lib/types';
import { RpcDialog, toast, useRpc } from './client';
import { Icon } from './Icon';
import { Flags, KindTag } from './ui';

export function ReviewTime({ entries, names, titles, tz, originals }: {
  entries: Entry[]; names: Record<string, string>; titles: Record<number, string>; tz: string; originals: Record<number, Entry>;
}) {
  const [sel, setSel] = useState<number[]>([]);
  const { run, busy } = useRpc();
  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  async function approve(ids: number[]) {
    const r = await run('decide_entries', { p_ids: ids, p_approve: true, p_note: '' });
    if (!r.ok) return toast(r.error, 'error');
    toast(`Approved ${ids.length} entr${ids.length > 1 ? 'ies' : 'y'}`);
    setSel([]);
  }
  if (!entries.length) return <p className="empty card">No time entries waiting for approval.</p>;
  const flagged = entries.filter((e) => e.flagged).length;
  return (
    <>
      <div className="btn-row">
        <button className="btn sm" type="button" onClick={() => setSel(entries.filter((e) => !e.flagged).map((e) => e.id))}>Select all{flagged ? ' except flagged' : ''}</button>
        <button className="btn primary sm" type="button" disabled={!sel.length || busy} onClick={() => approve(sel)}><Icon name="check" />Approve selected ({sel.length})</button>
        {flagged > 0 && <span className="small muted">{flagged} flagged session{flagged > 1 ? 's' : ''}: check before approving.</span>}
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th><span className="sr">Select</span></th><th>Date</th><th>Worker</th><th>Task</th><th>Time</th><th className="r">Hours</th><th>Summary</th><th className="r">Pay if approved</th><th>Actions</th></tr></thead>
          <tbody>
            {entries.map((e) => {
              const o = e.corrects_id ? originals[e.corrects_id] : undefined;
              return (
                <tr key={e.id}>
                  <td><input type="checkbox" aria-label={`Select entry ${e.id}`} checked={sel.includes(e.id)} onChange={() => toggle(e.id)} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.started_at, tz)}<div className="tid">#{e.id}</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{names[e.worker_id]}</td>
                  <td style={{ minWidth: 150 }}><Link className="link" href={`/tasks/${e.task_id}?tab=time`}>T-{e.task_id} {titles[e.task_id]}</Link></td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtTime(e.started_at, tz)}–{fmtTime(e.ended_at, tz)}<div><KindTag e={e} /></div></td>
                  <td className="r num">{fmtH(hrs(e))}</td>
                  <td style={{ minWidth: 220 }}>
                    {e.summary}
                    {e.reason && <div className="small muted"><b>Reason:</b> {e.reason}</div>}
                    {o && <div className="small muted">Changes #{o.id} from {fmtTime(o.started_at, tz)}–{fmtTime(o.ended_at, tz)} ({fmtH(hrs(o))})</div>}
                    <div><Flags e={e} /></div>
                  </td>
                  <td className="r num">{money(hrs(e) * Number(e.rate), e.currency)}<div className="small muted">{money(e.rate, e.currency)}/h</div></td>
                  <td>
                    <div className="btn-row">
                      <button className="btn sm primary" type="button" disabled={busy} onClick={() => approve([e.id])}><Icon name="check" />Approve</button>
                      <RpcDialog small icon="x" label="Reject" title={`Reject time entry #${e.id}`} fn="decide_entry"
                        intro={<p className="muted">The entry stays in the record marked Rejected and is not paid.</p>}
                        fields={[{ name: 'note', label: 'Reason (the worker sees this)', type: 'textarea', required: true, minLength: 3 }]}
                        args={{ p_entry: e.id, p_approve: false, p_note: { field: 'note' } }} submitLabel="Reject entry" danger />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
