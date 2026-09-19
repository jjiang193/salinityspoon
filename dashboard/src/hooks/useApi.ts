import { useEffect, useRef, useState } from 'react';
import { getJson } from '../lib/api';

export interface ApiState<T> {
  data: T | null;
  /** True only before the first answer. A refetch keeps showing what it has. */
  loading: boolean;
  error: string | null;
}

/**
 * Stored data, fetched per path and refetched when `revision` moves.
 *
 * A refetch never blanks the screen: a bite lands every fifteen seconds, and a
 * roster that flashed to a spinner each time would be unreadable. Only a change
 * of `path` - a different patient - clears what is showing.
 */
export function useApi<T>(path: string | null, revision = 0, pollMs = 0): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    setState({ data: null, loading: path !== null, error: null });
  }, [path]);

  useEffect(() => {
    if (path === null) return;
    let stale = false;
    const load = () => getJson<T>(path)
      .then((data) => { if (!stale) setState({ data, loading: false, error: null }); })
      .catch((e: Error) => {
        if (!stale) setState((prev) => ({ ...prev, loading: false, error: e.message }));
      });
    load();
    // Polling is for views with no session socket to tell them something moved:
    // the roster watches every patient, and a NaTrack session watches one.
    const timer = pollMs > 0 ? setInterval(load, pollMs) : null;
    return () => { stale = true; if (timer) clearInterval(timer); };
  }, [path, revision, pollMs]);

  return state;
}

/**
 * The last answer for `key`, held while a new one loads.
 *
 * useApi clears on a change of path, which is right for a change of patient and
 * wrong for a change of range: switching Week to Month should redraw the chart,
 * not blank the page around it. Keyed so one patient's data never stands in for
 * another's.
 */
export function useSticky<T>(value: T | null, key: string): T | null {
  const last = useRef<{ key: string; value: T } | null>(null);
  if (value !== null) last.current = { key, value };
  return value ?? (last.current?.key === key ? last.current.value : null);
}
