import Link from 'next/link';
import { addDays, addMonths, type Period } from '@/lib/period';

export function PeriodNav({ base, type, per, today }: { base: string; type: 'week' | 'month'; per: Period; today: string }) {
  const prev = type === 'week' ? addDays(per.startDay, -7) : addMonths(per.startDay, -1);
  const next = type === 'week' ? addDays(per.startDay, 7) : addMonths(per.startDay, 1);
  const href = (t: string, a: string) => `${base}?type=${t}&anchor=${a}`;
  const seg = (on: boolean): React.CSSProperties => ({ padding: '6px 11px', fontSize: 13, textDecoration: 'none', background: on ? 'var(--accent)' : 'var(--surface)', color: on ? 'var(--accent-ink)' : 'var(--ink)' });
  return (
    <div className="filters">
      <span className="seg" role="group" aria-label="Period type">
        <Link href={href('week', per.startDay)} aria-pressed={type === 'week'} style={seg(type === 'week')}>Weekly</Link>
        <Link href={href('month', per.startDay)} aria-pressed={type === 'month'} style={seg(type === 'month')}>Monthly</Link>
      </span>
      <Link className="btn sm" href={href(type, prev)} aria-label="Previous period">‹ Previous</Link>
      <b style={{ minWidth: 150, textAlign: 'center' }}>{per.label}</b>
      <Link className="btn sm" href={href(type, next)} aria-label="Next period">Next ›</Link>
      <Link className="btn ghost sm" href={href(type, today)}>Current</Link>
    </div>
  );
}
