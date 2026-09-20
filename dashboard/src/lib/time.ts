/** Rolling-window axis labels. "10:21" as minute:second reads like a clock
 *  time; "-90s" cannot be misread. */
export function relativeTick(t: number, now: number): string {
  const s = Math.round((t - now) / 1000);
  return s >= 0 ? 'now' : `${s}s`;
}

/**
 * Ticks for a live chart's time axis: whole seconds back from `now`, in a step
 * chosen from how long the window is. Left to itself Recharts ticks a
 * three-second window at fractional seconds, which relativeTick rounds into
 * "-3s  -3s  -2s  now".
 */
export function relativeTicks(first: number, now: number): number[] {
  const span = (now - first) / 1000;
  const step = (span < 8 ? 1 : span < 40 ? 5 : 30) * 1000;
  const ticks: number[] = [];
  for (let t = now; t >= first; t -= step) ticks.unshift(t);
  return ticks;
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

/** The local calendar day an instant falls on, YYYY-MM-DD - the same key the
 *  server gives `daily[].date`, so a reading lands on the day it was taken. */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
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
