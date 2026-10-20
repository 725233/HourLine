'use client';
import { useState } from 'react';
import { firstName } from '@/lib/format';
import type { Comment } from '@/lib/types';
import { FilePicker, MAX_FILE, toast, uploadFiles, useRpc } from './client';
import { AttachmentList, type FileItem } from './Attachments';
import { Icon } from './Icon';

interface Props {
  taskId: number;
  comments: Comment[];
  files: Record<number, FileItem[]>;
  names: Record<string, string>;
  managers: string[];
  meId: string;
  isManager: boolean;
  assigneeName: string;
  closed: boolean;
  waitingCount: number;
  tz: string;
  startKind?: 'comment' | 'question';
}

const when = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export function Discussion(p: Props) {
  const [filter, setFilter] = useState<'all' | 'questions'>('all');
  const [kind, setKind] = useState<'comment' | 'question' | 'note'>(p.startKind ?? 'comment');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const { run, busy, error } = useRpc();
  const tops = p.comments.filter((c) => !c.parent_id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const shown = filter === 'questions' ? tops.filter((c) => c.kind === 'question') : tops;
  const openQs = tops.filter((c) => c.kind === 'question' && c.q_status !== 'resolved').length;
  const kinds: [typeof kind, string][] = p.isManager
    ? [['comment', 'Comment'], ['question', 'Question for ' + firstName(p.assigneeName)]]
    : [['comment', 'Comment'], ['question', 'Question for clarification'], ['note', 'Work update']];
  const placeholder = {
    comment: p.isManager ? `Write a message to ${p.assigneeName}` : 'Write a message to your manager',
    question: p.isManager ? `Ask ${firstName(p.assigneeName)} something about the work` : 'What do you need clarified? Be specific so your manager can answer quickly.',
    note: 'Share progress: what you finished, what is next',
  }[kind];

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if (files.some((f) => f.size > MAX_FILE)) return toast('Each file must be 10 MB or smaller.', 'error');
    const r = await run('post_comment', { p_task: p.taskId, p_kind: kind, p_body: text, p_parent: null });
    if (!r.ok) return;
    if (files.length) await uploadFiles(p.taskId, files, { comment: Number(r.data) });
    setText(''); setFiles([]); setKind('comment');
    toast(kind === 'question' ? 'Question sent. You’ll get a notification when there’s a reply.' : 'Sent.');
  }

  return (
    <>
      {p.waitingCount > 0 && (
        <div className="note warn"><Icon name="comment" /><div><b>{p.waitingCount} question{p.waitingCount > 1 ? 's' : ''} waiting for your answer.</b> Use Reply below.</div></div>
      )}
      <div className="filters">
        <span className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Everything ({tops.length})</button>
          <button type="button" aria-pressed={filter === 'questions'} onClick={() => setFilter('questions')}>Questions ({openQs} open)</button>
        </span>
      </div>
      <div className="list" style={{ gap: 10 }}>
        {shown.length ? shown.map((c) => (
          <Thread key={c.id} c={c} p={p} replies={p.comments.filter((r) => r.parent_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at))}
            replying={replyTo === c.id} onReply={() => setReplyTo(c.id)} onDone={() => setReplyTo(null)} />
        )) : <p className="empty">{filter === 'questions' ? 'No questions on this task.' : 'No messages yet. Ask a question if anything about the task is unclear.'}</p>}
      </div>
      {p.closed ? <p className="small muted">This task is cancelled, so new messages are closed.</p> : (
        <form className="card" onSubmit={send} id="composer" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="fld"><span>New message</span>
            <span className="seg" role="group" aria-label="Message type">
              {kinds.map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
            </span>
          </div>
          <label className="fld"><span className="sr">Message</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} required autoFocus={!!p.startKind} />
            {kind === 'question' && <small>Questions stay open until someone marks them resolved, and show up on the {p.isManager ? 'worker’s' : 'manager’s'} dashboard.</small>}
          </label>
          <div className="fld"><label htmlFor="c-files" style={{ fontSize: 12.5, fontWeight: 600 }}>Attach files or screenshots (optional)</label><FilePicker id="c-files" files={files} onChange={setFiles} /></div>
          {error && <p className="form-err" role="alert">{error}</p>}
          <div className="btn-row">
            <span className="small muted">{p.isManager ? `${p.assigneeName} gets a notification.` : 'Your manager gets a notification.'}</span>
            <button className="btn primary" style={{ marginLeft: 'auto' }} disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="send" />}{kind === 'question' ? 'Ask question' : kind === 'note' ? 'Post update' : 'Send'}</button>
          </div>
        </form>
      )}
    </>
  );
}

function Thread({ c, p, replies, replying, onReply, onDone }: { c: Comment; p: Props; replies: Comment[]; replying: boolean; onReply: () => void; onDone: () => void }) {
  const { run, busy, error } = useRpc();
  const [text, setText] = useState('');
  const [resolve, setResolve] = useState(false);
  const answered = replies.some((r) => r.author_id !== c.author_id);
  const state = c.kind !== 'question' ? '' : c.q_status === 'resolved' ? 'resolved' : answered ? 'answered' : 'open';
  async function reply(e: React.FormEvent) {
    e.preventDefault();
    const r = await run('post_comment', { p_task: p.taskId, p_kind: 'comment', p_body: text, p_parent: c.id });
    if (!r.ok) return;
    if (resolve) await run('set_question_status', { p_comment: c.id, p_resolved: true });
    setText(''); onDone(); toast('Reply sent.');
  }
  return (
    <div className={'comment ' + (c.kind === 'note' ? 'note-k' : c.kind === 'question' ? 'q-k' : '')}>
      <Head c={c} p={p} state={state} />
      <div className="prose">{c.body}</div>
      {p.files[c.id] && <AttachmentList items={p.files[c.id]} />}
      {c.kind === 'question' && state === 'resolved' && c.resolved_by && <div className="small muted">Resolved by {p.names[c.resolved_by]} · {when(c.resolved_at!, p.tz)}</div>}
      {replies.length > 0 && (
        <div className="replies">
          {replies.map((r) => (
            <div className="comment reply" key={r.id}>
              <Head c={r} p={p} state="" />
              <div className="prose">{r.body}</div>
              {p.files[r.id] && <AttachmentList items={p.files[r.id]} />}
            </div>
          ))}
        </div>
      )}
      {replying ? (
        <form className="reply-form" onSubmit={reply}>
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} required
            placeholder={c.kind === 'question' && c.author_id !== p.meId ? `Answer ${firstName(p.names[c.author_id])}’s question` : 'Write a reply'} />
          <div className="btn-row">
            {c.kind === 'question' && state !== 'resolved' && (
              <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} /> Mark question resolved</label>
            )}
            <span style={{ marginLeft: 'auto' }} />
            {error && <span className="form-err">{error}</span>}
            <button type="button" className="btn ghost sm" onClick={onDone}>Cancel</button>
            <button className="btn primary sm" disabled={busy}><Icon name="send" />Send reply</button>
          </div>
        </form>
      ) : !p.closed && (
        <div className="btn-row">
          <button className="btn sm ghost" type="button" onClick={onReply}><Icon name="undo" />Reply{replies.length ? ` (${replies.length})` : ''}</button>
          {c.kind === 'question' && state !== 'resolved' && (
            <button className="btn sm ghost" type="button" disabled={busy} onClick={() => run('set_question_status', { p_comment: c.id, p_resolved: true })}><Icon name="check" />Mark resolved</button>
          )}
          {c.kind === 'question' && state === 'resolved' && (
            <button className="btn sm ghost" type="button" disabled={busy} onClick={() => run('set_question_status', { p_comment: c.id, p_resolved: false })}>Reopen</button>
          )}
        </div>
      )}
    </div>
  );
}

function Head({ c, p, state }: { c: Comment; p: Props; state: string }) {
  return (
    <div className="who">
      <b>{p.names[c.author_id] ?? 'Unknown'}</b>
      {p.managers.includes(c.author_id) && <span className="tag">Manager</span>}
      {c.kind === 'note' && <span className="tag">Work update</span>}
      {c.kind === 'question' && <span className="tag" style={{ color: 'var(--violet)' }}>Question</span>}
      {state === 'open' && <span className="pill e-pending">Waiting for answer</span>}
      {state === 'answered' && <span className="pill s-prog">Answered</span>}
      {state === 'resolved' && <span className="pill s-done">Resolved</span>}
      <span className="faint">{when(c.created_at, p.tz)}</span>
    </div>
  );
}
