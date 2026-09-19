/** Rolling-window axis labels. "10:21" as minute:second reads like a clock
 *  time; "-90s" cannot be misread. */
export function relativeTick(t: number, now: number): string {
  const s = Math.round((t - now) / 1000);
  return s >= 0 ? 'now' : `${s}s`;
}

/** Tooltips and tables get the unambiguous wall-clock time. */
export function clockTime(t: number | string): string {
  const d = typeof t === 'string' ? new Date(t) : new Date(t);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** "Today", "Yesterday", "4 days ago" - for a roster, where the gap is the point. */
export function daysAgo(days: number | null): string {
  if (days === null) return 'Never';
  if (days === 0) return 'Today';
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

/** A YYYY-MM-DD local day. Parsed by hand: `new Date('2026-09-14')` is midnight
 *  UTC, which is the 13th anywhere west of Greenwich. */
function localDay(isoDay: string): Date {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function shortDay(isoDay: string): string {
  return localDay(isoDay).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function weekday(isoDay: string): string {
  return localDay(isoDay).toLocaleDateString([], { weekday: 'short' });
}

export function dayAndTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
