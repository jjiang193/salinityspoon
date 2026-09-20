import { useState } from 'react';
import { HealthLog, PatientDetail, SummaryRange } from '../types';
import { TelemetryState } from '../hooks/useTelemetry';
import { useApi, useSticky } from '../hooks/useApi';
import { href, usePageTitle } from '../lib/route';
import { errorText } from '../lib/api';
import { REFERENCE_SERVING_ML, fmtMg } from '../lib/sodium';
import { dayAndTime, daysAgo } from '../lib/time';
import * as sev from '../lib/severity';
import { Chip } from '../components/Chip';
import { DailyTrendChart } from '../components/DailyTrendChart';
import { MealsTable } from '../components/MealsTable';
import { SodiumSources } from '../components/SodiumSources';
import { StatTile } from '../components/StatTile';
import { TargetEditor } from '../components/TargetEditor';
import { VitalsTimeline } from '../components/VitalsTimeline';

/** Covers a month of several readings a day. */
const LOG_LIMIT = 120;

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
  // Asked for once: the timeline draws it and lists it. The endpoint is capped
  // by rows, not by date, so the timeline is told the cap and can say when the
  // answer may stop short of the period.
  const log = useApi<HealthLog[]>(
    `/v1/patients/${patientId}/health-log?limit=${LOG_LIMIT}`, telemetry.revision,
  );
  const logError = log.error !== null && !log.data;
  usePageTitle(p ? `${p.name} · Clinician` : null);

  const back = (
    <a className="crumb" href={href({ view: 'clinician', patientId: null })}>← All patients</a>
  );

  if (loading && !p) return <>{back}<p className="empty">Loading…</p></>;
  if (!p) {
    return (
      <>
        {back}
        <p className="empty" role="status">
          {error === 'Not found'
            ? `There is no patient with the id “${patientId}”.`
            : `Could not load this patient. ${errorText(new Error(error ?? ''))}`}
        </p>
      </>
    );
  }

  const input: sev.RosterInput = {
    pctToday: p.pct_of_target_today,
    pctAvg: p.pct_of_target_avg,
    daysSinceLog: p.days_since_log,
    flaggedMeals: p.flagged_meals,
    upwardDrift: p.upward_drift,
    driftPct: p.drift_pct,
    windowDays: p.window_days,
  };
  const status = sev.rosterStatus(input);
  // The chip says the first reason. The rest are said too, as text: a patient
  // over target today can also be trending up, and that is worth a sentence,
  // not a second chip.
  const reasons = sev.rosterReasons(input);
  const others = reasons.slice(1);
  // "Which food" for a label flag. The other reasons have their figure in the
  // tiles; this one's was only in the sources table, two charts further down.
  // Text, not a second chip: the chip and the table row already carry the colour.
  const flaggedSources = reasons.some((r) => r.key === 'label-flag')
    ? p.sources.items.filter((i) => i.flagged_count > 0) : [];

  // Audit #1 on the third view: a meal is open and the spoon has stopped
  // sending. Ambient text, not colour - the clinician cannot switch it on.
  const spoonSilent = telemetry.connected && !telemetry.spoonLive
    && telemetry.silentForS !== null;

  const drift = p.drift_pct === null
    ? 'not enough logged days to compare with the week before'
    : `${p.drift_pct >= 0 ? '+' : '−'}${Math.abs(p.drift_pct).toFixed(0)}% on the week before`;

  return (
    <>
      {back}
      <div className="view-head">
        <div>
          <h2 className="view-title" tabIndex={-1}>{p.name}</h2>
          <p className="view-sub">
            {[p.age && `${p.age} years`, p.condition].filter(Boolean).join(' · ')}
            {' · '}target {fmtMg(p.sodiumTarget)} mg/day
          </p>
          {others.length > 0 && (
            <p className="view-sub">Also: {others.map((r) => r.text).join(' · ')}</p>
          )}
          {flaggedSources.length > 0 && (
            <p className="view-sub">
              Label flag: {flaggedSources.map((i) => (
                `${i.name ?? 'an undeclared product'}`
                + (i.label_claim_label ? ` (labelled ${i.label_claim_label.toLowerCase()})` : '')
                + `, ${i.flagged_count} of ${i.count} meal${i.count === 1 ? '' : 's'}`
                + (i.mg_per_serving !== null
                  ? `, typically ${fmtMg(i.mg_per_serving)} mg per ${REFERENCE_SERVING_ML} mL` : '')
              )).join('; ')}
              {' '}in the last {p.sources.days} days. See the sources below.
            </p>
          )}
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
          <strong>
            {spoonSilent
              ? `Meal open, spoon silent for ${sev.silentFor(telemetry.silentForS ?? 0)}.`
              : 'Eating now.'}
          </strong>{' '}
          {spoonSilent && 'Last received: '}
          {telemetry.mealTotals.biteCount} bite{telemetry.mealTotals.biteCount === 1 ? '' : 's'},{' '}
          {fmtMg(telemetry.mealTotals.totalSodium)} mg {spoonSilent ? 'this meal' : 'so far this meal'}
          {' '}(range {fmtMg(telemetry.mealTotals.total_sodium_mg_low)}–
          {fmtMg(telemetry.mealTotals.total_sodium_mg_high)}).{' '}
          <a href={href({ view: 'live' })}>Watch live</a>
        </div>
      )}

      <div className="tiles">
        {/* Today is excluded from every average on this page, so without this
            tile a chip can say "Over target today" with no figure behind it. */}
        <StatTile
          label="Today so far"
          value={p.today.logged ? fmtMg(p.today.total_sodium_mg) : '—'}
          unit={p.today.logged ? 'mg' : undefined}
          note={p.today.logged
            ? `${p.today.total_sodium_mg_high > p.today.total_sodium_mg_low
                ? `range ${fmtMg(p.today.total_sodium_mg_low)}–${fmtMg(p.today.total_sodium_mg_high)} · `
                : ''}${p.pct_of_target_today.toFixed(0)}% of target · not part of the averages`
            : 'nothing logged yet today'} />
        <StatTile
          label={`${p.window_days}-day average`}
          value={p.avg_sodium_mg === null ? '—' : fmtMg(p.avg_sodium_mg)}
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
        <div className="stack">
          <DailyTrendChart daily={p.daily} targetMg={p.sodiumTarget}
                           range={range} onRange={setRange} syncId="days" />
          <VitalsTimeline daily={p.daily} entries={log.data} error={logError} syncId="days"
                          limit={LOG_LIMIT} />
        </div>
        {/* In a stack of one so the target card is not stretched to the charts'
            height. The readings as a table are inside the timeline's card. */}
        <div className="stack">
          <TargetEditor patient={p} onSaved={telemetry.bump} />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <SodiumSources sources={p.sources} />
      </div>

      <div style={{ marginTop: 16 }}>
        <MealsTable meals={p.meals} />
      </div>

      <div style={{ marginTop: 16 }}>
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
                    <td className="num primary">{fmtMg(m.sodium_mg)} mg</td>
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
