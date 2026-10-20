import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Redirects to a short-lived signed link for a private file the user can see.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createClient();
  const { data: a } = await sb.from('attachments').select('storage_path, name').eq('id', Number(id)).maybeSingle();
  if (!a?.storage_path) return new NextResponse('Not found', { status: 404 });
  const download = new URL(request.url).searchParams.has('download') ? a.name : undefined;
  const { data, error } = await sb.storage.from('task-files').createSignedUrl(a.storage_path, 300, { download });
  if (error || !data) return new NextResponse('Not found', { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
