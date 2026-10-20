import Link from 'next/link';
import { getContext } from '@/lib/context';
import { code, fmtDT } from '@/lib/format';
import { Icon } from '@/components/Icon';
import { Empty } from '@/components/ui';
import { RpcButton } from '@/components/client';
import type { Notice } from '@/lib/types';

export const metadata = { title: 'Notifications' };

export default async function Notifications() {
  const { sb, me, settings } = await getContext();
  const { data } = await sb.from('notifications').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(200);
  const list = (data ?? []) as Notice[];
  const unread = list.filter((n) => !n.read);
  return (
    <>
      <div className="page-head"><h1 style={{ marginRight: 'auto' }}>Notifications</h1>
        {unread.length > 0 && <RpcButton fn="mark_notifications_read" args={{ p_ids: null }} label="Mark all as read" icon="check" small />}</div>
      <section className="card">
        <div className="list">
          {list.length ? list.map((n) => (
            <div className="li" key={n.id}>
              <span className={'li-ic ' + (n.read ? '' : 'violet')}><Icon name="bell" /></span>
              <div className="li-main">
                <span style={n.read ? undefined : { fontWeight: 600 }}>{n.body}</span>
                <span className="small faint">{fmtDT(n.created_at, settings.timezone)}{!n.read && <> · <b style={{ color: 'var(--accent)' }}>New</b></>}</span>
              </div>
              {n.task_id && <Link className="btn sm" href={`/tasks/${n.task_id}`}>Open {code(n.task_id)}</Link>}
              {!n.read && <RpcButton fn="mark_notifications_read" args={{ p_ids: [n.id] }} label="Mark read" small variant="ghost" />}
            </div>
          )) : <Empty>No notifications.</Empty>}
        </div>
      </section>
      <section className="card">
        <div className="card-h"><h2>Email notifications</h2><span className="pill e-pending">Future integration</span></div>
        <p className="muted">Hourline only sends sign-in and invite emails today. Assignment, review, hour-limit and approval notices are in-app only. Email delivery for these can be added with a mail service.</p>
      </section>
    </>
  );
}
