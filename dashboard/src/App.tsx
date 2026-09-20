import { useEffect, useState } from 'react';
import { useTelemetry } from './hooks/useTelemetry';
import { useApi } from './hooks/useApi';
import { DEFAULT_PATIENT_ID, href, useRoute } from './lib/route';
import { ClinicianRoster } from './views/ClinicianRoster';
import { ClinicianPatient } from './views/ClinicianPatient';
import { PatientView } from './views/PatientView';
import { LiveView } from './views/LiveView';
import { Chip } from './components/Chip';
import { ThemeToggle } from './components/ThemeToggle';
import * as sev from './lib/severity';
import { PROBE_TEMP_MAX_C, SpoonStatus } from './types';
import { cloudMode, onAuthChange, ownPatientId, role, signOut, signedIn, signedInAs } from './lib/cloud';
import { SignIn } from './components/SignIn';

/** A spoon that last sent a sample longer ago than this is not switched on. */
const SPOON_ONLINE_S = 10;

/**
 * NaTrack's three views: the clinician dashboard, the patient portal, the live
 * session.
 *
 * A live session belongs to one patient (/session/{patientId}), so the socket
 * follows whoever is on screen: the patient in the portal, the patient in the
 * clinician's chart, or - on the Live tab - whoever holds the spoon. The roster
 * shows every patient and so has no session; it polls.
 */
export default function App() {
  // A cloud build has to know who is asking before it asks anything. A local
  // build is already signed in by not having accounts at all.
  const [authed, setAuthed] = useState(signedIn());
  useEffect(() => onAuthChange(setAuthed), []);

  const route = useRoute();

  // Who holds the spoon. Polled: it changes when someone starts a meal, which
  // no single patient's session is entitled to hear about.
  const spoon = useApi<SpoonStatus>(cloudMode ? null : '/api/spoon', 0, 5000);
  const holderId = spoon.data?.patientId ?? null;
  // Any spoon at all, by the server's clock. Null until the server has said:
  // "unknown" must not read as "off". A failed poll keeps the last answer, so
  // it is only believed while the polls are succeeding.
  const spoonOnline = spoon.data && spoon.error === null
    ? spoon.data.sample_age_s !== null && spoon.data.sample_age_s < SPOON_ONLINE_S
    : null;

  const gated = cloudMode && !authed;
  const who = cloudMode ? role() : null;
  const isPatientUser = who === 'patient';

  const sessionPatientId = route.view === 'live' ? holderId : route.patientId;
  const telemetry = useTelemetry(sessionPatientId);

  // With no session open, the roster's own polling is the evidence of a link.
  // A session refused for an unknown patient is closed too, but the server
  // answered to refuse it - so there as well the polling is the evidence.
  const connected = sessionPatientId !== null && !telemetry.notFound
    ? telemetry.connected
    // In cloud mode there is no spoon poll to judge by, so the live session is
    // the only evidence; with none open, say connected rather than claim a
    // server is down when nothing has been asked of it.
    : cloudMode ? true : spoon.error === null;

  // The Patient tab remembers whose chart you were just reading.
  const portalPatientId = isPatientUser
    ? (ownPatientId() ?? DEFAULT_PATIENT_ID)
    : (route.view !== 'live' && route.patientId) || holderId || DEFAULT_PATIENT_ID;

  if (gated) return <SignIn />;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3.5c3 3.6 5.5 6.6 5.5 10a5.5 5.5 0 0 1-11 0c0-3.4 2.5-6.4 5.5-10z" />
              <path d="M9.5 14.5h5M12 12v5" />
            </svg>
          </span>
          <div>
            <h1>Salinity Spoon</h1>
            <p className="sub">
              Sodium monitoring for sodium-restricted diets · measures liquids, 0–{PROBE_TEMP_MAX_C} °C
            </p>
          </div>
        </div>
        <div className="masthead-tools">
          <Chip indicator={sev.connection(connected)} />
          <ThemeToggle />
        </div>
      </header>

      <nav className="tabs" aria-label="Views">
        {!isPatientUser && (
          <a href={href({ view: 'clinician', patientId: null })}
             aria-current={route.view === 'clinician' ? 'page' : undefined}>
            Clinician
          </a>
        )}
        <a href={href({ view: 'patient', patientId: portalPatientId, tab: 'today' })}
           aria-current={route.view === 'patient' ? 'page' : undefined}>
          Patient portal
        </a>
        <a href={href({ view: 'live' })}
           aria-current={route.view === 'live' ? 'page' : undefined}>
          Live
        </a>
        {cloudMode ? (
          <span className="tabs-note">
            Synthetic patients · signed in as {signedInAs() ?? who}
            <button type="button" className="linklike" onClick={signOut}>Sign out</button>
          </span>
        ) : (
          <span className="tabs-note">Demo build · synthetic patients · no sign-in</span>
        )}
      </nav>

      {isPatientUser && route.view === 'clinician' ? (
        <PatientView patientId={portalPatientId} tab="today" telemetry={telemetry}
                     spoonOnline={spoonOnline} />
      ) : route.view === 'live' ? (
        <LiveView patientId={holderId} telemetry={telemetry} spoonError={spoon.error} />
      ) : route.view === 'patient' ? (
        <PatientView patientId={route.patientId} tab={route.tab} telemetry={telemetry}
                     spoonOnline={spoonOnline} />
      ) : route.patientId ? (
        <ClinicianPatient patientId={route.patientId} telemetry={telemetry} />
      ) : (
        <ClinicianRoster />
      )}
    </div>
  );
}
