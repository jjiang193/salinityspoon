import { useState } from 'react';
import {
  IntakeToday, PatientDetail, PatientSummary, PROBE_TEMP_MAX_C, SummaryRange,
} from '../types';
import { TelemetryState } from '../hooks/useTelemetry';
import { useApi, useSticky } from '../hooks/useApi';
import { href } from '../lib/route';
import { MealHero } from '../components/MealHero';
import { DailyMeter } from '../components/DailyMeter';
import { BiteChart } from '../components/BiteChart';
import { SodiumProjection } from '../components/SodiumProjection';
import { LabelCheckCard } from '../components/LabelCheckCard';
import { ManualMealForm } from '../components/ManualMealForm';
import { SessionCard } from '../components/SessionCard';
import { HealthLogCard } from '../components/HealthLogCard';
import { DailyTrendChart } from '../components/DailyTrendChart';
import { MealsTable } from '../components/MealsTable';
import { StatTile } from '../components/StatTile';
import { FoodMatrixSelector } from '../components/FoodMatrixSelector';
import { EchoDebriefCard } from '../components/EchoDebriefCard';
import { SystemLimitsCard } from '../components/SystemLimitsCard';

interface Props {
  patientId: string;
  tab: 'today' | 'history';
  telemetry: TelemetryState;
}

/**
 * NaTrack's patient portal: their meal, their day, their own health readings.
 *
 * The instrument panel - sensor state, sample traces, the bite table - lives on
 * the Live tab. A patient needs to know what they ate, not what the ADC read.
 *
 * There is no sign-in in this build, so "who am I" is a dropdown. It stands in
 * for a session; the switcher goes away the day auth arrives, and nothing else
 * on this screen needs to change (PLAN.md §9).
 */
export function PatientView({ patientId, tab, telemetry }: Props) {
  const roster = useApi<PatientSummary[]>('/v1/patients', telemetry.revision);
  const me = roster.data?.find((p) => p.patientId === patientId);

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title">{me ? me.name : 'My sodium'}</h2>
          <p className="view-sub">
            {me
              ? <>Your daily target is <strong>{me.sodiumTarget.toLocaleString()} mg</strong>, set by your care team</>
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
        ? <Today patientId={patientId} telemetry={telemetry} />
        : <History patientId={patientId} revision={telemetry.revision} />}
    </>
  );
}

function Today({ patientId, telemetry: t }: { patientId: string; telemetry: TelemetryState }) {
  const { data: intake } =
    useApi<IntakeToday>(`/api/intake/today?patientId=${patientId}`, t.revision);
  const targetMg = intake?.sodiumTarget ?? 2300;

  // Keyed on the last reading taken IN the liquid. Between dips the probe reads
  // room air, which is in range and tells us nothing about the soup.
  const outOfRange = t.lastSubmergedInRange === false;

  return (
    <>
      {outOfRange && (
        <div className="banner-warn">
          <strong>Liquid is out of the probe's range
          {t.lastSubmergedTempC !== null && ` — last measured ${t.lastSubmergedTempC.toFixed(1)} °C`}.</strong>{' '}
          The DFR0300 is rated 0–{PROBE_TEMP_MAX_C} °C. No bites will be logged until it
          cools — a reading taken outside that range is not less precise, it is
          unsupported.
        </div>
      )}

      {t.lastError && !outOfRange && (
        <div className="banner-warn"><strong>Last refusal:</strong> {t.lastError}</div>
      )}

      <div className="grid hero">
        <MealHero totals={t.mealTotals} activeMealId={t.activeMealId} targetMg={targetMg} />
        <div className="stack">
          <SessionCard patientId={patientId} activeMealId={t.activeMealId}
                       spoonBusyElsewhere={t.spoonBusyElsewhere}
                       connected={t.connected} onChange={t.bump} />
          <DailyMeter intake={intake} />
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <BiteChart bites={t.bites} />
        <SodiumProjection bites={t.bites} intake={intake} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <ManualMealForm patientId={patientId} onChange={t.bump} />
        <HealthLogCard patientId={patientId} editable revision={t.revision} onChange={t.bump} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <FoodMatrixSelector activeMealId={t.activeMealId} onChange={t.bump} />
        <EchoDebriefCard activeMealId={t.activeMealId} />
      </div>

      <div style={{ marginTop: 16 }}>
        <SystemLimitsCard />
      </div>

      <div style={{ marginTop: 16 }}>
        <LabelCheckCard check={t.labelCheck} activeMealId={t.activeMealId} />
      </div>
    </>
  );
}

function History({ patientId, revision }: { patientId: string; revision: number }) {
  const [range, setRange] = useState<SummaryRange>('month');
  const { data, loading } =
    useApi<PatientDetail>(`/v1/patients/${patientId}/summary?range=${range}`, revision);
  const p = useSticky(data, patientId);

  if (loading && !p) return <p className="empty">Loading…</p>;
  if (!p) return <p className="empty">Could not load your history.</p>;

  const within = p.days_logged - p.days_over_target;

  return (
    <>
      <div className="tiles">
        <StatTile
          label={`${p.window_days}-day average`}
          value={p.avg_sodium_mg === null ? '—' : Math.round(p.avg_sodium_mg).toLocaleString()}
          unit={p.avg_sodium_mg === null ? undefined : 'mg'}
          note={p.pct_of_target_avg === null
            ? 'log a day to see an average'
            : `${p.pct_of_target_avg.toFixed(0)}% of your ${p.sodiumTarget.toLocaleString()} mg target`} />
        <StatTile
          label="Days within target"
          value={p.days_logged === 0 ? '—' : `${within} of ${p.days_logged}`}
          note="of the days you logged" />
        <StatTile
          label="Days logged"
          value={`${p.days_logged} of ${p.window_days}`}
          note="days you did not log are left out, not counted as zero" />
      </div>

      <div style={{ marginTop: 16 }}>
        <DailyTrendChart daily={p.daily} targetMg={p.sodiumTarget} range={range} onRange={setRange}
                         caption="Against your daily target · gaps are days with nothing logged" />
      </div>

      <div style={{ marginTop: 16 }}>
        <MealsTable meals={p.meals} />
      </div>
    </>
  );
}
