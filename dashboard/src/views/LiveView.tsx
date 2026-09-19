import { IntakeToday, PatientSummary } from '../types';
import { TelemetryState } from '../hooks/useTelemetry';
import { useApi } from '../hooks/useApi';
import { href } from '../lib/route';
import { MealHero } from '../components/MealHero';
import { SensorStatus } from '../components/SensorStatus';
import { SalinityChart } from '../components/SalinityChart';
import { TemperatureChart } from '../components/TemperatureChart';
import { BiteTable } from '../components/BiteTable';
import { BiteChart } from '../components/BiteChart';
import { SodiumProjection } from '../components/SodiumProjection';
import { LabelCheckCard } from '../components/LabelCheckCard';

/**
 * NaTrack's third view: the live session, which is also the demo.
 *
 * Read-only by design. It watches whoever holds the spoon - the patient starts
 * and ends meals from their portal, the clinician sets targets from theirs, and
 * this screen touches nothing. It is also where the instrument lives: sensor
 * state, the bite table, the sample traces.
 */
export function LiveView({ patientId, telemetry: t }: {
  /** Whoever holds the spoon. Null until the backend has said. */
  patientId: string | null;
  telemetry: TelemetryState;
}) {
  const roster = useApi<PatientSummary[]>('/v1/patients');
  const { data: intake } = useApi<IntakeToday>(
    patientId ? `/api/intake/today?patientId=${patientId}` : null, t.revision,
  );
  const who = roster.data?.find((p) => p.patientId === patientId);
  const outOfRange = t.lastSubmergedInRange === false;

  if (patientId === null) return <p className="empty">Finding the spoon…</p>;

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title">Live session</h2>
          <p className="view-sub">
            {who ? <>The spoon is with <strong>{who.name}</strong></> : 'The spoon is paired'}
            {t.activeMealId !== null ? ` · meal #${t.activeMealId} in progress` : ' · waiting for a bite'}
          </p>
        </div>
        {who && (
          <a className="btn btn-quiet" href={href({ view: 'clinician', patientId })}>
            Open {who.name.split(' ')[0]}'s chart
          </a>
        )}
      </div>

      {outOfRange && (
        <div className="banner-warn">
          <strong>Liquid is out of the probe's range
          {t.lastSubmergedTempC !== null && ` — last measured ${t.lastSubmergedTempC.toFixed(1)} °C`}.</strong>{' '}
          No bites will be logged until it cools. A reading outside 0–40 °C is not
          less precise, it is unsupported.
        </div>
      )}
      {t.lastError && !outOfRange && (
        <div className="banner-warn"><strong>Last refusal:</strong> {t.lastError}</div>
      )}

      <div className="grid hero">
        <MealHero totals={t.mealTotals} activeMealId={t.activeMealId}
                  targetMg={intake?.sodiumTarget ?? 2300} />
        <SensorStatus
          connected={t.connected}
          latest={t.latest}
          lastError={t.lastError}
          lastSubmergedTempC={t.lastSubmergedTempC}
          lastSubmergedInRange={t.lastSubmergedInRange}
        />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <BiteChart bites={t.bites} />
        <SodiumProjection bites={t.bites} intake={intake} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <BiteTable bites={t.bites} />
        <LabelCheckCard check={t.labelCheck} activeMealId={null} />
      </div>

      <details className="card diag" style={{ marginTop: 16 }} open>
        <summary>Signal diagnostics — sample-level traces</summary>
        <div className="grid two">
          <SalinityChart points={t.points} />
          <TemperatureChart points={t.points} />
        </div>
      </details>
    </>
  );
}
