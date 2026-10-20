'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { fmtSize } from '@/lib/format';
import { FilePicker, MAX_FILE, Modal, toast, uploadFiles } from './client';
import { Icon } from './Icon';

export interface FileItem { id: number; kind: 'file' | 'link'; name: string; href: string; isImage: boolean; size: number | null }

export function AttachmentList({ items }: { items: FileItem[] }) {
  const [preview, setPreview] = useState<FileItem | null>(null);
  if (!items.length) return <p className="empty" style={{ padding: 0 }}>Nothing attached yet.</p>;
  const imgs = items.filter((a) => a.kind === 'file' && a.isImage);
  const rest = items.filter((a) => !imgs.includes(a));
  return (
    <>
      {imgs.length > 0 && (
        <div className="thumbs">
          {imgs.map((a) => (
            <button key={a.id} className="thumb" type="button" onClick={() => setPreview(a)} aria-label={'Open ' + a.name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.href} alt="" />
              <span className="thumb-n">{a.name}</span>
            </button>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className="att">
          {rest.map((a) => a.kind === 'link'
            ? <a key={a.id} href={a.href} target="_blank" rel="noopener noreferrer"><Icon name="link" />{a.name}</a>
            : <a key={a.id} href={`/api/files/${a.id}?download=1`}><Icon name="clip" />{a.name} <span className="faint small">{fmtSize(a.size)}</span></a>)}
        </div>
      )}
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)} wide>
          <div className="modal-b">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="preview-img" src={preview.href} alt={preview.name} />
            <p className="small muted">{preview.name} · {fmtSize(preview.size)}</p>
            <div className="modal-f"><a className="btn primary" href={`/api/files/${preview.id}?download=1`}><Icon name="download" />Download</a></div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function AddFiles({ taskId }: { taskId: number }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!files.length) return;
    if (files.some((f) => f.size > MAX_FILE)) return toast('Each file must be 10 MB or smaller.', 'error');
    setBusy(true);
    await uploadFiles(taskId, files);
    setBusy(false); setOpen(false); setFiles([]);
    router.refresh();
    toast('Files attached.');
  }
  return (
    <>
      <button className="btn sm" type="button" onClick={() => setOpen(true)}><Icon name="clip" />Add files</button>
      {open && (
        <Modal title="Add files and images" onClose={() => setOpen(false)}>
          <form onSubmit={go}>
            <div className="fld"><label htmlFor="af-files" style={{ fontSize: 12.5, fontWeight: 600 }}>Files</label><FilePicker id="af-files" files={files} onChange={setFiles} /></div>
            <div className="modal-f">
              <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn primary" disabled={busy || !files.length}>{busy && <span className="spinner" />}Upload</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
