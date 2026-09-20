import { useState } from 'react';
import { PatientSummary } from '../types';
import { useApi } from '../hooks/useApi';
import { errorText } from '../lib/api';
import { href } from '../lib/route';
import { fmtMg } from '../lib/sodium';
import { daysAgo } from '../lib/time';
import * as sev from '../lib/severity';
import { Chip } from '../components/Chip';
import { Sparkline } from '../components/Sparkline';
import { StatTile } from '../components/StatTile';

/**
 * The panel: every patient on one screen, most pressing first.
 *
 * It answers one question - who should I look at? - so each row carries exactly
 * one status chip and the rest is plain numbers. Everything is arithmetic over
 * logged days against the target the clinician set. There is no risk score here
 * and there should not be: this device measures soup.
 *
 * The three count tiles are filters. Counts and filters both read the keys of
 * sev.rosterReasons, so a patient a tile counts is always a patient it finds -
 * including one whose single chip is saying something more pressing. While a
 * filter is on, the row prints that reason as text; it still carries one chip.
 */
/** The roster watches every patient and so has no session socket; it polls. */
const POLL_MS = 10_000;

const FILTER_LABEL: Partial<Record<sev.ReasonKey, string>> = {
  'above-avg': 'above target on average',
  'trending-up': 'trending up',
  lapsed: 'not logging',
};

export function ClinicianRoster({ clinicianId = 'clinician-1' }: { clinicianId?: string }) {
  const { data, loading, error } =
    useApi<PatientSummary[]>(`/v1/patients?clinicianId=${clinicianId}`, 0, POLL_MS);
  const [filter, setFilter] = useState<sev.ReasonKey | null>(null);

  if (loading) return <p className="empty">Loading patients…</p>;
  if (!data) {
    return (
      <p className="empty" role="status">
        Could not load patients. {errorText(new Error(error ?? ''))}
      </p>
    );
  }

  const rows = data
    .map((p) => {
      const input: sev.RosterInput = {
        pctToday: p.pct_of_target_today,
        pctAvg: p.pct_of_target_avg,
        daysSinceLog: p.days_since_log,
        flaggedMeals: p.flagged_meals,
        upwardDrift: p.upward_drift,
        driftPct: p.drift_pct,
        windowDays: p.window_days,
      };
      return { p, status: sev.rosterStatus(input), reasons: sev.rosterReasons(input) };
    })
    .sort((a, b) =>
      sev.urgency(a.status) - sev.urgency(b.status)
      || (b.p.pct_of_target_avg ?? 0) - (a.p.pct_of_target_avg ?? 0));

  const windowDays = data[0]?.window_days ?? 7;
  const count = (key: sev.ReasonKey) =>
    rows.filter((r) => r.reasons.some((x) => x.key === key)).length;
  const toggle = (key: sev.ReasonKey) => setFilter(filter === key ? null : key);
  const visible = filter === null
    ? rows
    : rows.filter((r) => r.reasons.some((x) => x.key === filter));

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title" tabIndex={-1}>Patients</h2>
          <p className="view-sub">
            Sodium intake against each patient's own target · averages cover the last{' '}
            {windowDays} full days
          </p>
        </div>
      </div>

      <div className="tiles">
        <StatTile label="Monitored" value={String(data.length)} note="patients with a spoon" />
        <StatTile label="Above target" value={String(count('above-avg'))}
                  note={`of ${data.length} patients · ${windowDays}-day average`}
                  onClick={() => toggle('above-avg')} pressed={filter === 'above-avg'} />
        <StatTile label="Trending up" value={String(count('trending-up'))}
                  note="this week 15%+ above last week"
                  onClick={() => toggle('trending-up')} pressed={filter === 'trending-up'} />
        <StatTile label="Not logging" value={String(count('lapsed'))}
                  note={`${sev.LAPSE_DAYS}+ days without an entry`}
                  onClick={() => toggle('lapsed')} pressed={filter === 'lapsed'} />
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        {/* Always mounted, so a screen reader hears the table change under it. */}
        <p className="filter-line" role="status">
          {filter !== null && (
            <>
              Showing {visible.length} of {rows.length} · {FILTER_LABEL[filter]} ·{' '}
              <button type="button" className="btn-link" onClick={() => setFilter(null)}>
                Show all
              </button>
            </>
          )}
        </p>
        {visible.length === 0 ? <p className="empty">No patients match.</p> : (
        <div className="scroller"><table className="roster">
          <thead>
            <tr>
              <th>Patient</th>
              <th className="num">Target</th>
              <th className="num">{windowDays}-day avg</th>
              <th className="num">Days over</th>
              <th>Last 14 days</th>
              <th className="num">Today</th>
              <th>Last log</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ p, status, reasons }) => {
              const to = href({ view: 'clinician', patientId: p.patientId });
              return (
                <tr key={p.patientId} onClick={() => { location.hash = to; }}>
                  <td>
                    <a className="row-link" href={to}>{p.name}</a>
                    <div className="sub-line">
                      {[p.age, p.condition].filter(Boolean).join(' · ')}
                    </div>
                    {/* Why the filter kept this row, when its chip says something else. */}
                    {filter !== null && (
                      <div className="sub-line">
                        {reasons.find((r) => r.key === filter)?.text}
                      </div>
                    )}
                    {/* On a phone the Status column scrolls out of sight, and it
                        is the one column that says who to look at. */}
                    <div className="status-inline"><Chip indicator={status} /></div>
                  </td>
                  <td className="num">{p.sodiumTarget.toLocaleString()}</td>
                  <td className="num">
                    {p.avg_sodium_mg === null ? <span className="muted">—</span> : (
                      <>
                        <span className="primary">{fmtMg(p.avg_sodium_mg)}</span>
                        <div className="sub-line">{p.pct_of_target_avg!.toFixed(0)}% of target</div>
                      </>
                    )}
                  </td>
                  <td className="num">
                    {p.days_logged === 0 ? <span className="muted">—</span> : (
                      <>
                        <span className="primary">{p.days_over_target}</span> of {p.days_logged}
                        <div className="sub-line">logged days</div>
                      </>
                    )}
                  </td>
                  <td><Sparkline daily={p.daily} targetMg={p.sodiumTarget} /></td>
                  <td className="num">
                    {p.today.logged
                      ? <>
                          <span className="primary">{fmtMg(p.today.total_sodium_mg)}</span>
                          <div className="sub-line">{p.pct_of_target_today.toFixed(0)}% of target</div>
                        </>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="nowrap">{daysAgo(p.days_since_log)}</td>
                  <td>
                    <div className="chip-stack">
                      <Chip indicator={status} />
                      {p.in_meal && <Chip indicator={sev.mealInProgress()} />}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        )}
      </section>

      <p className="footnote">
        <strong>How to read these numbers.</strong> Sodium is in mg. Totals are liquids
        measured by the spoon plus items the patient entered by hand, so they are a lower
        bound on dietary sodium, not the whole diet. The spoon measures NaCl-equivalent
        salinity — conductivity reads all ions, not sodium alone. Days with nothing logged
        are left out of averages rather than counted as zero.
      </p>
    </>
  );
}
