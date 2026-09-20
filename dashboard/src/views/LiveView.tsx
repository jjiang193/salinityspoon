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
import { InterlockBanner } from '../components/InterlockBanner';
import { SpoonSilentBanner } from '../components/SpoonSilentBanner';

/**
 * NaTrack's third view: the live session, which is also the demo.
 *
 * Read-only by design. It watches whoever holds the spoon - the patient starts
 * and ends meals from their portal, the clinician sets targets from theirs, and
 * this screen touches nothing. It is also where the instrument lives: sensor
 * state, the bite table, the sample traces.
 */
export function LiveView({ patientId, telemetry: t, spoonError }: {
  /** Whoever holds the spoon. Null until the backend has said. */
  patientId: string | null;
  telemetry: TelemetryState;
  /** Why the backend has not said, if asking it failed. */
  spoonError: string | null;
}) {
  // On the revision, which also moves when the session re-opens after an outage.
  const roster = useApi<PatientSummary[]>('/v1/patients', t.revision);
  const { data: intake, error: intakeError } = useApi<IntakeToday>(
    patientId ? `/api/intake/today?patientId=${patientId}` : null, t.revision,
  );
  const who = roster.data?.find((p) => p.patientId === patientId);
  const outOfRange = t.lastSubmergedInRange === false;
  const inMeal = t.activeMealId !== null;
  const silentMidMeal = inMeal && t.connected && !t.spoonLive && t.silentForS !== null;

  if (patientId === null) {
    // "Finding…" forever is what a dead backend used to look like.
    return (
      <p className="empty" role="status">
        {spoonError
          ? "Can't reach the server. The live view starts when it is back."
          : 'Finding the spoon…'}
      </p>
    );
  }

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title" tabIndex={-1}>Live session</h2>
          <p className="view-sub">
            {who ? <>The spoon is with <strong>{who.name}</strong></> : 'The spoon is paired'}
            {/* What cannot be heard is not reported as quiet: the server first. */}
            {!t.connected
              ? ' · server unreachable'
              : t.activeMealId !== null
                ? ` · ${t.mealLabel?.product_name ?? 'meal'} in progress${silentMidMeal ? ', spoon not sending' : ''}`
                : t.spoonLive ? ' · spoon on, waiting for a dip' : ' · spoon not sending'}
          </p>
        </div>
        {who && (
          <a className="btn btn-quiet" href={href({ view: 'clinician', patientId })}>
            Open {who.name.split(' ')[0]}'s chart
          </a>
        )}
      </div>

      {/* The same banner, under the same condition, as the patient's Today: the
          hero below is the biggest thing on the demo screen and is frozen. */}
      {silentMidMeal && <SpoonSilentBanner silentForS={t.silentForS ?? 0} />}
      {outOfRange && <InterlockBanner tempC={t.lastSubmergedTempC} audience="instrument" />}

      <div className="grid hero">
        <MealHero totals={t.mealTotals} activeMealId={t.activeMealId}
                  targetMg={intake?.sodiumTarget ?? null}
                  mealName={t.mealLabel?.product_name ?? null}
                  volumeSource={t.bites[0]?.volume_source}
                  spoonSeen={t.spoonLive} />
        <SensorStatus
          connected={t.connected}
          spoonLive={t.spoonLive}
          silentForS={t.silentForS}
          inMeal={inMeal}
          latest={t.latest}
          lastError={t.lastError}
          lastSubmergedTempC={t.lastSubmergedTempC}
          lastSubmergedInRange={t.lastSubmergedInRange}
          // A dip "counted" beside values hidden as stale would read as current.
          lastDip={silentMidMeal || !t.connected ? null : t.lastDip}
          dipsNotCounted={t.dipsNotCounted}
        />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <BiteChart bites={t.bites} />
        <SodiumProjection bites={t.bites} intake={intake} intakeError={intakeError !== null}
                          suspended={outOfRange} inMeal={inMeal}
                          stalled={!inMeal ? null : !t.connected ? 'server' : silentMidMeal ? 'spoon' : null} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <BiteTable bites={t.bites} />
        <LabelCheckCard check={t.labelCheck} />
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
