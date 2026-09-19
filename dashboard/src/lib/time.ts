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

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
