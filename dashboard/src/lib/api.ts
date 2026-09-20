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

/** What a person is told when the request never got an answer. */
const UNREACHABLE = "Can't reach the server";

// Errors thrown here are shown to patients and clinicians as written. They say
// what happened in words and never carry a URL path or a bare status line.
function reach(request: Promise<Response>): Promise<Response> {
  return request.catch(() => { throw new Error(UNREACHABLE); });
}

// 502-504 come from whatever stands in front of the server when the server
// itself is not answering, which to the person reading is the same thing.
function failure(status: number): string {
  if (status === 404) return 'Not found';
  if (status >= 502 && status <= 504) return UNREACHABLE;
  // A bare status code is not something a patient or a clinician can act on.
  return 'The server had a problem. Try again in a moment.';
}

/** An answer that was not OK. `status` is for the few callers with something
 *  better to say about one code (a 409 on a label) than the server's sentence. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await reach(fetch(withTz(path)));
  if (!res.ok) throw new ApiError(failure(res.status), res.status);
  return res.json();
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown,
): Promise<T> {
  const res = await reach(fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  if (!res.ok) {
    // The server's `detail` is written for a person, in lower case.
    const detail = await res.json().then((d) => d.detail).catch(() => null);
    throw new ApiError(typeof detail === 'string' && detail
      ? detail.charAt(0).toUpperCase() + detail.slice(1)
      : failure(res.status), res.status);
  }
  return res.json();
}

/** Anything caught, as one sentence a person can read. */
export function errorText(e: unknown): string {
  const text = e instanceof Error && e.message ? e.message : UNREACHABLE;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
