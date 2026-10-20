import type { SupabaseClient } from '@supabase/supabase-js';
import type { Comment, Profile } from './types';

export interface OpenQuestion { q: Comment; answered: boolean }

/** Open clarification questions (visible to the current user) and whether each has a reply. */
export async function openQuestions(sb: SupabaseClient, taskIds?: number[]) {
  let query = sb.from('comments').select('*').eq('kind', 'question').eq('q_status', 'open');
  if (taskIds) query = query.in('task_id', taskIds.length ? taskIds : [-1]);
  const { data: qs } = await query;
  const list = (qs ?? []) as Comment[];
  if (!list.length) return [] as OpenQuestion[];
  const { data: replies } = await sb.from('comments').select('parent_id, author_id').in('parent_id', list.map((q) => q.id));
  return list.map((q) => ({ q, answered: (replies ?? []).some((r) => r.parent_id === q.id && r.author_id !== q.author_id) }));
}

/** Questions waiting for a reply from this person. */
export function waitingOn(qs: OpenQuestion[], me: Profile, assigneeOf: (taskId: number) => string | undefined, roleOf: (id: string) => string | undefined) {
  return qs.filter(({ q, answered }) => {
    if (answered || q.author_id === me.id) return false;
    return roleOf(q.author_id) === 'manager' ? assigneeOf(q.task_id) === me.id : me.role === 'manager';
  });
}
