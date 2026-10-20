import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from './supabase/server';
import type { Hours, Profile, Settings } from './types';

/** Signed-in user, profile and org settings for the current request. */
export const getContext = cache(async () => {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect('/login');
  const [{ data: me }, { data: settings }, { data: people }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    sb.from('app_settings').select('*').eq('id', 1).maybeSingle(),
    sb.from('profiles').select('*').order('full_name'),
  ]);
  if (!me || !me.active) redirect('/login?inactive=1');
  const team = (people ?? []) as Profile[];
  const names = new Map(team.map((p) => [p.id, p.full_name || p.email]));
  return {
    sb,
    me: me as Profile,
    isManager: me.role === 'manager',
    settings: (settings ?? { org_name: 'Hourline', timezone: 'UTC', long_session_hours: 6, max_entry_hours: 12, warn_ratio: 0.8, max_file_bytes: 10485760 }) as Settings,
    team,
    name: (id: string | null | undefined) => (id ? names.get(id) ?? 'Unknown' : 'System'),
  };
});

export async function requireManager() {
  const ctx = await getContext();
  if (!ctx.isManager) redirect('/');
  return ctx;
}

export async function hoursFor(ids: number[]) {
  const { sb } = await getContext();
  if (!ids.length) return new Map<number, Hours>();
  const { data } = await sb.rpc('task_hours', { p_ids: ids });
  return new Map(((data ?? []) as Hours[]).map((h) => [Number(h.task_id), {
    ...h, logged: Number(h.logged), approved: Number(h.approved), pending: Number(h.pending), running: Number(h.running),
  }]));
}
