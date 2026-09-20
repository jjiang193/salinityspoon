import { useState } from 'react';
import { IntakeToday, PatientDetail, PatientSummary, SummaryRange } from '../types';
import { TelemetryState } from '../hooks/useTelemetry';
import { useApi, useSticky } from '../hooks/useApi';
import { DEFAULT_PATIENT_ID, href } from '../lib/route';
import { errorText } from '../lib/api';
import { fmtMg } from '../lib/sodium';
import { TodayHero } from '../components/TodayHero';
import { BowlCard } from '../components/BowlCard';
import { LabelFlagAlert } from '../components/LabelFlagAlert';
import { ManualMealForm } from '../components/ManualMealForm';
import { SessionCard } from '../components/SessionCard';
import { HealthLogCard } from '../components/HealthLogCard';
import { DailyTrendChart } from '../components/DailyTrendChart';
import { MealsTable } from '../components/MealsTable';
import { SodiumSources } from '../components/SodiumSources';
import { StatTile } from '../components/StatTile';
import { InterlockBanner } from '../components/InterlockBanner';
import { SpoonSilentBanner } from '../components/SpoonSilentBanner';

interface Props {
  patientId: string;
  tab: 'today' | 'history';
  telemetry: TelemetryState;
  /** Any spoon is switched on and sending, by the server's clock. Null: unknown. */
  spoonOnline: boolean | null;
}

/**
 * NaTrack's patient portal: their meal, their day, their own health readings.
 *
 * The instrument panel - sensor state, sample traces, the bite table, per-bite
 * marks and the projection - lives on the Live tab. A patient needs to know
 * what they ate, not what the ADC read.
 *
 * Today answers one question, bowl in front of them: how much is left today,
 * and how much of THIS bowl fits in it. On a phone everything is one column, so
 * the order in the code is the order on the screen: alerts, what is left, this
 * bowl, the meal, solid food, health.
 *
 * There is no sign-in in this build, so "who am I" is a dropdown. It stands in
 * for a session; the switcher goes away the day auth arrives, and nothing else
 * on this screen needs to change (PLAN.md §9).
 */
export function PatientView({ patientId, tab, telemetry, spoonOnline }: Props) {
  // Polled, so a page opened while the server was down fills in when it is back.
  const roster = useApi<PatientSummary[]>('/v1/patients', telemetry.revision, 15000);
  const me = roster.data?.find((p) => p.patientId === patientId);

  if (telemetry.notFound || (roster.data !== null && !me)) {
    // A mistyped or stale link. Nothing under it would load either, so there
    // are no tabs and no Today to stand around empty.
    return (
      <>
        <p className="empty" role="status">There is no patient with the id “{patientId}”.</p>
        <p className="empty" style={{ paddingTop: 0 }}>
          <a href={href({ view: 'patient', patientId: DEFAULT_PATIENT_ID, tab: 'today' })}>
            Open the default patient's portal
          </a>
        </p>
      </>
    );
  }

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title" tabIndex={-1}>{me ? me.name : 'My sodium'}</h2>
          <p className="view-sub">
            {me
              ? <>Your daily limit is <strong>{fmtMg(me.sodiumTarget)} mg</strong>, set by your care team</>
              : roster.error
                ? "Can't reach the server right now. This page fills in when it is back."
                : ' '}
          </p>
        </div>
        <label className="switcher">
          <span>Viewing as</span>
          <select className="field" value={patientId}
                  onChange={(e) => {
                    location.hash = href({ view: 'patient', patientId: e.target.value, tab });
                  }}>
            {(roster.data ?? []).map((p) => (
              <option key={p.patientId} value={p.patientId}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>

      <nav className="segmented" aria-label="Patient sections">
        <a href={href({ view: 'patient', patientId, tab: 'today' })}
           aria-current={tab === 'today' ? 'page' : undefined}>Today</a>
        <a href={href({ view: 'patient', patientId, tab: 'history' })}
           aria-current={tab === 'history' ? 'page' : undefined}>My history</a>
      </nav>

      {tab === 'today'
        ? <Today patientId={patientId} telemetry={telemetry} spoonOnline={spoonOnline} />
        : <History patientId={patientId} revision={telemetry.revision} />}
    </>
  );
}

function Today({ patientId, telemetry: t, spoonOnline }: {
  patientId: string; telemetry: TelemetryState; spoonOnline: boolean | null;
}) {
  // Polled as well as revision-driven: a fetch that failed recovers without a reload.
  const intakeApi =
    useApi<IntakeToday>(`/api/intake/today?patientId=${patientId}`, t.revision, 15000);
  const intake = intakeApi.data;

  // Keyed on the last reading taken IN the liquid. Between dips the probe reads
  // room air, which is in range and tells us nothing about the soup.
  const outOfRange = t.lastSubmergedInRange === false;
  // Only while the server can be heard: a dead socket is not a quiet spoon.
  const silentMidMeal = t.activeMealId !== null && t.connected && !t.spoonLive
    && t.silentForS !== null;
  const bowlInPlay = t.activeMealId !== null || (t.mealTotals?.biteCount ?? 0) > 0;
  // The session's own evidence when this patient holds the spoon: the poll lags
  // it by seconds, and for those seconds the hero and SessionCard used to disagree.
  const spoonSeen = t.holder ? t.spoonLive : spoonOnline === true;
  // A banner already says why nothing counts; the dip line answers the rest.
  const shownDip = outOfRange || silentMidMeal ? null : t.lastDip;

  return (
    <>
      {/* The alert slot. The only coloured things the portal can add to the
          page, all at the existing critical tier, all above everything else. */}
      {silentMidMeal && <SpoonSilentBanner silentForS={t.silentForS ?? 0} />}
      {outOfRange && <InterlockBanner tempC={t.lastSubmergedTempC} audience="patient" />}
      {t.labelCheck?.flagged && <LabelFlagAlert check={t.labelCheck} />}

      <div className="grid hero">
        <TodayHero intake={intake} loading={intakeApi.loading} error={intakeApi.error !== null}
                   bowlInPlay={bowlInPlay}
                   lastDip={shownDip}
                   dipsNotCounted={t.dipsNotCounted}
                   spoonBusyElsewhere={t.spoonBusyElsewhere}
                   spoonSeen={spoonSeen} />
        <div className="stack">
          {bowlInPlay && (
            <BowlCard mealTotals={t.mealTotals} mealLabel={t.mealLabel}
                      labelCheck={t.labelCheck} intake={intake} suspended={outOfRange}
                      inMeal={t.activeMealId !== null}
                      volumeSource={t.bites[0]?.volume_source}
                      lastDip={shownDip} dipsNotCounted={t.dipsNotCounted}
                      spoonSeen={spoonSeen} />
          )}
          <SessionCard patientId={patientId} activeMealId={t.activeMealId}
                       mealLabel={t.mealLabel}
                       spoonBusyElsewhere={t.spoonBusyElsewhere}
                       connected={t.connected} holder={t.holder}
                       spoonLive={t.spoonLive} silentForS={t.silentForS}
                       spoonOnline={spoonOnline} onChange={t.bump} />
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <ManualMealForm patientId={patientId} onChange={t.bump}
                        activeMealId={t.activeMealId}
                        targetMg={intake?.sodiumTarget ?? null} />
        <HealthLogCard patientId={patientId} editable revision={t.revision} onChange={t.bump} />
      </div>
    </>
  );
}

function History({ patientId, revision }: { patientId: string; revision: number }) {
  const [range, setRange] = useState<SummaryRange>('month');
  const { data, loading, error } =
    useApi<PatientDetail>(`/v1/patients/${patientId}/summary?range=${range}`, revision);
  const p = useSticky(data, patientId);

  if (loading && !p) return <p className="empty">Loading…</p>;
  if (!p) {
    return (
      <p className="empty" role="status">
        Could not load your history. {errorText(new Error(error ?? ''))}
      </p>
    );
  }

  const within = p.days_logged - p.days_over_target;

  return (
    <>
      {error !== null && data === null && (
        // What shows is the last answer, held by useSticky. Say so.
        <p className="form-note" role="status" style={{ marginTop: 0 }}>
          Couldn't refresh. {errorText(new Error(error))} This is the last history received.
        </p>
      )}
      <div className="tiles">
        <StatTile
          label={`${p.window_days}-day average`}
          value={p.avg_sodium_mg === null ? '—' : fmtMg(p.avg_sodium_mg)}
          unit={p.avg_sodium_mg === null ? undefined : 'mg'}
          note={p.pct_of_target_avg === null
            ? 'log a day to see an average'
            : `${p.pct_of_target_avg.toFixed(0)}% of your ${fmtMg(p.sodiumTarget)} mg limit`} />
        <StatTile
          label="Days within limit"
          value={p.days_logged === 0 ? '—' : `${within} of ${p.days_logged}`}
          note="of the days you logged" />
        <StatTile
          label="Days logged"
          value={`${p.days_logged} of ${p.window_days}`}
          note="days you did not log are left out, not counted as zero" />
      </div>

      <div style={{ marginTop: 16 }}>
        <DailyTrendChart daily={p.daily} targetMg={p.sodiumTarget} range={range} onRange={setRange}
                         noun="limit"
                         caption="Against your daily limit · gaps are days with nothing logged" />
      </div>

      <div style={{ marginTop: 16 }}>
        <SodiumSources sources={p.sources} variant="patient" />
      </div>

      <div style={{ marginTop: 16 }}>
        <MealsTable meals={p.meals} variant="patient" />
      </div>
    </>
  );
}
