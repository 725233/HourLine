import { todayIn, zonedToISO } from './format';

const d = (s: string) => new Date(s + 'T00:00:00Z');
const s = (x: Date) => x.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => { const x = d(day); x.setUTCDate(x.getUTCDate() + n); return s(x); };
export const addMonths = (day: string, n: number) => { const x = d(day); return s(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, 1))); };
export const weekStart = (day: string) => { const x = d(day); return addDays(day, -((x.getUTCDay() + 6) % 7)); };
export const monthStart = (day: string) => day.slice(0, 8) + '01';

export interface Period { startDay: string; endDay: string; from: string; to: string; label: string }

/** A calendar period in the organisation's time zone. endDay is exclusive. */
export function period(type: 'week' | 'month', anchor: string, tz: string): Period {
  const startDay = type === 'week' ? weekStart(anchor) : monthStart(anchor);
  const endDay = type === 'week' ? addDays(startDay, 7) : addMonths(startDay, 1);
  const fmt = (x: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(d(x));
  const label = type === 'week'
    ? 'Week of ' + fmt(startDay, { month: 'short', day: 'numeric', year: 'numeric' })
    : fmt(startDay, { month: 'long', year: 'numeric' });
  return { startDay, endDay, from: zonedToISO(startDay, '00:00', tz), to: zonedToISO(endDay, '00:00', tz), label };
}

export function preset(name: string, tz: string): Period | null {
  const today = todayIn(tz);
  if (name === 'week') return { ...period('week', today, tz), label: 'This week' };
  if (name === 'lastmonth') return { ...period('month', addMonths(today, -1), tz), label: 'Last month' };
  if (name === 'all') return null;
  return { ...period('month', today, tz), label: 'This month' };
}
