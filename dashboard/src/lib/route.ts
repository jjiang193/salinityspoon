import { useEffect, useState } from 'react';

/**
 * Hash routing, by hand. Three screens do not justify a router dependency, and
 * a hash survives the Vite proxy and a static file server alike.
 *
 *   #/clinician              the roster
 *   #/clinician/demo-2       one patient, as their clinician sees them
 *   #/patient/demo-1         that patient's own view, today
 *   #/patient/demo-1/history
 *   #/live                   whoever holds the spoon, as it happens
 *
 * NaTrack's three views: the clinician dashboard, the patient portal, the live demo.
 */
export type Route =
  | { view: 'clinician'; patientId: string | null }
  | { view: 'patient'; patientId: string; tab: 'today' | 'history' }
  | { view: 'live' };

export const DEFAULT_PATIENT_ID = 'demo-1';

export function parse(hash: string): Route {
  const [view, id, tab] = hash.replace(/^#\/?/, '').split('/');
  if (view === 'patient') {
    return {
      view: 'patient',
      patientId: id || DEFAULT_PATIENT_ID,
      tab: tab === 'history' ? 'history' : 'today',
    };
  }
  if (view === 'live') return { view: 'live' };
  return { view: 'clinician', patientId: id || null };
}

export function href(route: Route): string {
  if (route.view === 'live') return '#/live';
  if (route.view === 'clinician')
    return route.patientId ? `#/clinician/${route.patientId}` : '#/clinician';
  return `#/patient/${route.patientId}${route.tab === 'history' ? '/history' : ''}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const onChange = () => { setRoute(parse(location.hash)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
