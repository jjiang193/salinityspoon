import { useState } from 'react';
import { PatientDetail, SummaryRange } from '../types';
import { TelemetryState } from '../hooks/useTelemetry';
import { useApi, useSticky } from '../hooks/useApi';
import { href } from '../lib/route';
import { dayAndTime, daysAgo } from '../lib/time';
import * as sev from '../lib/severity';
import { Chip } from '../components/Chip';
import { DailyTrendChart } from '../components/DailyTrendChart';
import { HealthLogCard } from '../components/HealthLogCard';
import { MealsTable } from '../components/MealsTable';
import { StatTile } from '../components/StatTile';
import { TargetEditor } from '../components/TargetEditor';

/**
 * One patient, as their clinician sees them: the trend, the meals behind it,
 * and the target - which is the only thing on this screen a clinician edits.
 */
export function ClinicianPatient({ patientId, telemetry }: {
  patientId: string;
  telemetry: TelemetryState;
}) {
  const [range, setRange] = useState<SummaryRange>('month');
  const { data, loading, error } = useApi<PatientDetail>(
    `/v1/patients/${patientId}/summary?range=${range}`, telemetry.revision,
  );
  const p = useSticky(data, patientId);

  const back = (
    <a className="crumb" href={href({ view: 'clinician', patientId: null })}>← All patients</a>
  );

  if (loading && !p) return <>{back}<p className="empty">Loading…</p></>;
  if (!p) return <>{back}<p className="empty">Could not load this patient{error && ` (${error})`}.</p></>;

  const status = sev.rosterStatus({
    pctToday: p.pct_of_target_today,
    pctAvg: p.pct_of_target_avg,
    daysSinceLog: p.days_since_log,
    flaggedMeals: p.flagged_meals,
    upwardDrift: p.upward_drift,
    driftPct: p.drift_pct,
  });

  const drift = p.drift_pct === null
    ? 'not enough logged days to compare with the week before'
    : `${p.drift_pct >= 0 ? '+' : '−'}${Math.abs(p.drift_pct).toFixed(0)}% on the week before`;

  return (
    <>
      {back}
      <div className="view-head">
        <div>
          <h2 className="view-title">{p.name}</h2>
          <p className="view-sub">
            {[p.age && `${p.age} years`, p.condition].filter(Boolean).join(' · ')}
            {' · '}target {p.sodiumTarget.toLocaleString()} mg/day
          </p>
        </div>
        <div className="pill-row">
          <Chip indicator={status} />
          {p.in_meal && <Chip indicator={sev.mealInProgress()} />}
          <a className="btn btn-quiet"
             href={href({ view: 'patient', patientId: p.patientId, tab: 'today' })}>
            Open patient portal
          </a>
        </div>
      </div>

      {p.in_meal && telemetry.mealTotals && (
        <div className="banner-info">
          <strong>Eating now.</strong>{' '}
          {telemetry.mealTotals.biteCount} bites,{' '}
          {Math.round(telemetry.mealTotals.totalSodium).toLocaleString()} mg so far this meal
          {' '}(range {Math.round(telemetry.mealTotals.total_sodium_mg_low).toLocaleString()}–
          {Math.round(telemetry.mealTotals.total_sodium_mg_high).toLocaleString()}).{' '}
          <a href={href({ view: 'live' })}>Watch live</a>
        </div>
      )}

      <div className="tiles">
        <StatTile
          label={`${p.window_days}-day average`}
          value={p.avg_sodium_mg === null ? '—' : Math.round(p.avg_sodium_mg).toLocaleString()}
          unit={p.avg_sodium_mg === null ? undefined : 'mg'}
          note={p.pct_of_target_avg === null
            ? 'no logged days in the window'
            : <>{p.pct_of_target_avg.toFixed(0)}% of target · {drift}</>} />
        <StatTile
          label="Days over target"
          value={p.days_logged === 0 ? '—' : `${p.days_over_target} of ${p.days_logged}`}
          note={`logged days, last ${p.window_days}`} />
        <StatTile
          label="Eating pace"
          value={p.avgBiteIntervalSec === null ? '—' : p.avgBiteIntervalSec.toFixed(0)}
          unit={p.avgBiteIntervalSec === null ? undefined : 's between bites'}
          note={p.minBiteIntervalSec === null
            ? 'no meals in the window'
            : `quickest bite ${p.minBiteIntervalSec.toFixed(0)} s · ${p.pace_flagged_meals} fast-paced meal${p.pace_flagged_meals === 1 ? '' : 's'}`} />
        <StatTile
          label="Last log"
          value={daysAgo(p.days_since_log)}
          note={p.last_activity_at ? dayAndTime(p.last_activity_at) : 'no entries'} />
      </div>

      <div className="grid wide-narrow" style={{ marginTop: 16 }}>
        <DailyTrendChart daily={p.daily} targetMg={p.sodiumTarget}
                         range={range} onRange={setRange} />
        <TargetEditor patient={p} onSaved={telemetry.bump} />
      </div>

      <div style={{ marginTop: 16 }}>
        <MealsTable meals={p.meals} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <HealthLogCard patientId={p.patientId} editable={false} revision={telemetry.revision} />

        <section className="card">
          <h2>Self-reported food</h2>
          <p className="cap">
            Entered by the patient · the probe reads liquids only, so solids arrive this way
            and are never merged with measured values
          </p>
          {p.manual_meals.length === 0 ? (
            <p className="empty">Nothing self-reported.</p>
          ) : (
            <div className="scroller"><table>
              <thead>
                <tr><th>When</th><th>Food</th><th>Portion</th><th className="num">Sodium</th></tr>
              </thead>
              <tbody>
                {p.manual_meals.slice(0, 8).map((m) => (
                  <tr key={m.id}>
                    <td className="primary nowrap">{dayAndTime(m.ts_utc)}</td>
                    <td>{m.name}</td>
                    <td>{m.portion ?? '—'}</td>
                    <td className="num primary">{m.sodium_mg.toFixed(0)} mg</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      </div>

      <p className="footnote">
        Totals are a lower bound on dietary sodium: spoon-measured liquids plus what the
        patient entered. Measured values are NaCl-equivalent salinity. Pace figures are the
        device's own intervals, reported without a clinical threshold. This is monitoring
        data to inform a conversation, not a diagnostic.
      </p>
    </>
  );
}
