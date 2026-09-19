/**
 * Every read that involves a calendar day carries the viewer's UTC offset.
 *
 * Storage is UTC; a "day" is the viewer's day. Without this a 9 pm dinner in
 * New York lands in tomorrow's total (PLAN.md §7).
 */
const TZ_OFFSET_MIN = -new Date().getTimezoneOffset();

function withTz(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}tz_offset_min=${TZ_OFFSET_MIN}`;
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(withTz(path));
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export async function sendJson<T>(
  method: 'POST' | 'PUT', path: string, body: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.detail).catch(() => null);
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`);
  }
  return res.json();
}
