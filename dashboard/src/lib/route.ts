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

const SITE = 'Salinity Spoon';

/** The tab title for a route. A view refines it with the patient's name once
 *  it has one (`usePageTitle`); until then the id is what is known. */
export function titleFor(route: Route): string {
  if (route.view === 'live') return `Live · ${SITE}`;
  if (route.view === 'patient') return `My sodium · ${SITE}`;
  return route.patientId ? `${route.patientId} · Clinician · ${SITE}` : `Patients · ${SITE}`;
}

/** A view's own, better title - "Maria Santos · Clinician". Null leaves the
 *  route's title alone, so a view still loading does not blank the tab. */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    if (title) document.title = `${title} · ${SITE}`;
  }, [title]);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    let frame = 0;
    let waiting: MutationObserver | null = null;
    let giveUp = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      waiting?.disconnect();
      waiting = null;
      clearTimeout(giveUp);
    };
    const focusHeading = () => {
      const heading = document.querySelector<HTMLElement>('.view-title');
      heading?.focus({ preventScroll: true });
      return heading !== null;
    };
    const onChange = () => {
      setRoute(parse(location.hash));
      window.scrollTo(0, 0);
      // A hash change moves no focus by itself: a keyboard or screen-reader user
      // would be left on the link they pressed, above a page that changed under
      // them. One frame later the new view has rendered its heading - unless it
      // is still loading (a patient's chart has no name yet), in which case the
      // heading is waited for, briefly. Not on first load: the browser's own
      // starting point is the right one there.
      stop();
      frame = requestAnimationFrame(() => {
        if (focusHeading()) return;
        waiting = new MutationObserver(() => { if (focusHeading()) stop(); });
        waiting.observe(document.body, { childList: true, subtree: true });
        giveUp = window.setTimeout(stop, 4000);
      });
    };
    window.addEventListener('hashchange', onChange);
    return () => { stop(); window.removeEventListener('hashchange', onChange); };
  }, []);
  useEffect(() => { document.title = titleFor(route); }, [route]);
  return route;
}
