import Link from 'next/link';
import { getContext } from '@/lib/context';
import { code } from '@/lib/format';
import { Icon } from '@/components/Icon';
import { Clock, NavLinks, TimerSync, Toaster } from '@/components/client';
import type { Timer } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { sb, me, isManager, settings } = await getContext();
  await sb.rpc('sync_timers');
  const head = { count: 'exact' as const, head: true };
  const [{ data: timer }, { count: unread }, est, subs, ents, reqs] = await Promise.all([
    sb.from('timers').select('*').eq('worker_id', me.id).maybeSingle(),
    sb.from('notifications').select('id', head).eq('user_id', me.id).eq('read', false),
    isManager ? sb.from('tasks').select('id', head).eq('status', 'estimate_submitted') : Promise.resolve({ count: 0 }),
    isManager ? sb.from('tasks').select('id', head).eq('status', 'submitted') : Promise.resolve({ count: 0 }),
    isManager ? sb.from('time_entries').select('id', head).eq('status', 'pending') : Promise.resolve({ count: 0 }),
    isManager ? sb.from('hour_requests').select('id', head).eq('status', 'pending') : Promise.resolve({ count: 0 }),
  ]);
  const review = (est.count ?? 0) + (subs.count ?? 0) + (ents.count ?? 0) + (reqs.count ?? 0);
  const t = timer as Timer | null;
  const items = isManager
    ? [
        { href: '/', label: 'Dashboard', icon: 'home' },
        { href: '/tasks', label: 'Tasks', icon: 'list' },
        { href: '/review', label: 'Review & approvals', icon: 'review', count: review },
        { href: '/reports', label: 'Reports & pay', icon: 'chart' },
        { href: '/team', label: 'Team & projects', icon: 'users' },
        { href: '/activity', label: 'Activity history', icon: 'history' },
        { href: '/notifications', label: 'Notifications', icon: 'bell', count: unread ?? 0 },
      ]
    : [
        { href: '/', label: 'My dashboard', icon: 'home' },
        { href: '/tasks', label: 'My tasks', icon: 'list' },
        { href: '/timesheet', label: 'My timesheet', icon: 'clock' },
        { href: '/requests', label: 'My requests', icon: 'plus' },
        { href: '/notifications', label: 'Notifications', icon: 'bell', count: unread ?? 0 },
      ];
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark"><Icon name="clock" /></div>
          <div><b>{settings.org_name || 'Hourline'}</b><small>Tasks · time · pay</small></div>
        </div>
        <NavLinks items={items} />
        <div className="side-foot">
          <div style={{ color: '#fff', fontWeight: 600 }}>{me.full_name || me.email}</div>
          <div>{me.title || (isManager ? 'Manager' : 'Worker')}</div>
          <form action="/auth/signout" method="post" style={{ marginTop: 8 }}><button type="submit">Sign out</button></form>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <span className="tz-note" style={{ marginRight: 'auto' }}>Times shown in {settings.timezone}</span>
          {t && (
            <Link className="chip-timer" href={`/tasks/${t.task_id}`} style={{ textDecoration: 'none' }}>
              <span className="dot" /><span>{code(t.task_id)}</span><Clock since={t.started_at} />
            </Link>
          )}
          <Link className="btn bell" href="/notifications">
            <Icon name="bell" /><span>Notifications</span>{!!unread && <span className="badge">{unread}</span>}
          </Link>
          <form action="/auth/signout" method="post" className="mobile-only"><button className="btn ghost sm" type="submit">Sign out</button></form>
        </div>
        <main className="view">{children}</main>
      </div>
      <Toaster />
      <TimerSync active={!!t} />
    </div>
  );
}
