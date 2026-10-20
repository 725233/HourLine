import type { SupabaseClient } from '@supabase/supabase-js';
import type { FileItem } from '@/components/Attachments';
import type { Attachment } from './types';

const IMG = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/** Turns attachment rows into display items with short-lived signed links for private files. */
export async function toItems(sb: SupabaseClient, rows: Attachment[]): Promise<FileItem[]> {
  const paths = rows.filter((r) => r.kind === 'file' && r.storage_path).map((r) => r.storage_path!) as string[];
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data } = await sb.storage.from('task-files').createSignedUrls(paths, 3600);
    (data ?? []).forEach((d) => d.path && d.signedUrl && signed.set(d.path, d.signedUrl));
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    size: r.size_bytes,
    isImage: r.kind === 'file' && ((r.mime ?? '').startsWith('image/') || IMG.test(r.name)),
    href: r.kind === 'link' ? r.url ?? '#' : signed.get(r.storage_path ?? '') ?? `/api/files/${r.id}`,
  }));
}
