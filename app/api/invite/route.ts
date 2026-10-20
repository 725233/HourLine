import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// Managers invite people by email. The service key stays on the server.
export async function POST(request: NextRequest) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const { data: me } = await sb.from('profiles').select('role, active').eq('id', user.id).maybeSingle();
  if (!me || me.role !== 'manager' || !me.active) return NextResponse.json({ error: 'Only managers can invite people.' }, { status: 403 });

  const b = await request.json().catch(() => ({}));
  const email = String(b.email ?? '').trim().toLowerCase();
  const fullName = String(b.fullName ?? '').trim();
  const title = String(b.title ?? '').trim();
  const role = b.role === 'manager' ? 'manager' : 'worker';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  if (!fullName) return NextResponse.json({ error: 'Enter the person’s name.' }, { status: 400 });

  const site = process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin;
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName, title }, redirectTo: site + '/auth/callback' });
  if (error || !data.user) return NextResponse.json({ error: error?.message ?? 'Could not send the invite.' }, { status: 400 });

  // Name, title and role are set through the normal manager-only rules, so they are logged.
  const up = await sb.rpc('update_profile', { p_user: data.user.id, p_full_name: fullName, p_title: title, p_role: role, p_active: true });
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 400 });
  if (role === 'worker' && Number(b.rate) > 0) {
    const r = await sb.rpc('set_rate', { p_worker: data.user.id, p_rate: Number(b.rate), p_currency: String(b.currency ?? 'USD'), p_from: null });
    if (r.error) return NextResponse.json({ error: 'Invite sent, but the rate was not saved: ' + r.error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, id: data.user.id });
}
