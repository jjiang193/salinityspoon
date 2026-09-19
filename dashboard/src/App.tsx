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
import { PROBE_TEMP_MAX_C } from './types';

interface Spoon { patientId: string; mealId: number | null; deviceId: string | null }

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
  const route = useRoute();

  // Who holds the spoon. Polled: it changes when someone starts a meal, which
  // no single patient's session is entitled to hear about.
  const spoon = useApi<Spoon>('/api/spoon', 0, 5000);
  const holderId = spoon.data?.patientId ?? null;

  const sessionPatientId = route.view === 'live' ? holderId : route.patientId;
  const telemetry = useTelemetry(sessionPatientId);

  // With no session open, the roster's own polling is the evidence of a link.
  const connected = sessionPatientId !== null ? telemetry.connected : spoon.error === null;

  // The Patient tab remembers whose chart you were just reading.
  const portalPatientId =
    (route.view !== 'live' && route.patientId) || holderId || DEFAULT_PATIENT_ID;

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
        <a href={href({ view: 'clinician', patientId: null })}
           aria-current={route.view === 'clinician' ? 'page' : undefined}>
          Clinician
        </a>
        <a href={href({ view: 'patient', patientId: portalPatientId, tab: 'today' })}
           aria-current={route.view === 'patient' ? 'page' : undefined}>
          Patient portal
        </a>
        <a href={href({ view: 'live' })}
           aria-current={route.view === 'live' ? 'page' : undefined}>
          Live
        </a>
        <span className="tabs-note">Demo build · synthetic patients · no sign-in</span>
      </nav>

      {route.view === 'live' ? (
        <LiveView patientId={holderId} telemetry={telemetry} />
      ) : route.view === 'patient' ? (
        <PatientView patientId={route.patientId} tab={route.tab} telemetry={telemetry} />
      ) : route.patientId ? (
        <ClinicianPatient patientId={route.patientId} telemetry={telemetry} />
      ) : (
        <ClinicianRoster />
      )}
    </div>
  );
}
