import { PatientSummary } from '../types';
import { useApi } from '../hooks/useApi';
import { href } from '../lib/route';
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
 */
/** The roster watches every patient and so has no session socket; it polls. */
const POLL_MS = 10_000;

export function ClinicianRoster({ clinicianId = 'clinician-1' }: { clinicianId?: string }) {
  const { data, loading, error } =
    useApi<PatientSummary[]>(`/v1/patients?clinicianId=${clinicianId}`, 0, POLL_MS);

  if (loading) return <p className="empty">Loading patients…</p>;
  if (!data) return <p className="empty">Could not load patients{error && ` (${error})`}. Is the backend running?</p>;

  const rows = data
    .map((p) => ({
      p,
      status: sev.rosterStatus({
        pctToday: p.pct_of_target_today,
        pctAvg: p.pct_of_target_avg,
        daysSinceLog: p.days_since_log,
        flaggedMeals: p.flagged_meals,
        upwardDrift: p.upward_drift,
        driftPct: p.drift_pct,
      }),
    }))
    .sort((a, b) =>
      sev.urgency(a.status) - sev.urgency(b.status)
      || (b.p.pct_of_target_avg ?? 0) - (a.p.pct_of_target_avg ?? 0));

  const windowDays = data[0]?.window_days ?? 7;
  const aboveAvg = data.filter((p) => (p.pct_of_target_avg ?? 0) >= 100).length;
  const drifting = data.filter((p) => p.upward_drift).length;
  const lapsed = data.filter((p) => (p.days_since_log ?? 0) >= sev.LAPSE_DAYS).length;

  return (
    <>
      <div className="view-head">
        <div>
          <h2 className="view-title">Patients</h2>
          <p className="view-sub">
            Sodium intake against each patient's own target · averages cover the last{' '}
            {windowDays} full days
          </p>
        </div>
      </div>

      <div className="tiles">
        <StatTile label="Monitored" value={String(data.length)} note="patients with a spoon" />
        <StatTile label={`Above target · ${windowDays}-day avg`} value={String(aboveAvg)}
                  note={`of ${data.length} patients`} />
        <StatTile label="Trending up" value={String(drifting)}
                  note="this week 15%+ above last week" />
        <StatTile label="Not logging" value={String(lapsed)}
                  note={`${sev.LAPSE_DAYS}+ days without an entry`} />
      </div>

      <section className="card" style={{ marginTop: 16 }}>
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
            {rows.map(({ p, status }) => {
              const to = href({ view: 'clinician', patientId: p.patientId });
              return (
                <tr key={p.patientId} onClick={() => { location.hash = to; }}>
                  <td>
                    <a className="row-link" href={to}>{p.name}</a>
                    <div className="sub-line">
                      {[p.age, p.condition].filter(Boolean).join(' · ')}
                    </div>
                    {/* On a phone the Status column scrolls out of sight, and it
                        is the one column that says who to look at. */}
                    <div className="status-inline"><Chip indicator={status} /></div>
                  </td>
                  <td className="num">{p.sodiumTarget.toLocaleString()}</td>
                  <td className="num">
                    {p.avg_sodium_mg === null ? <span className="muted">—</span> : (
                      <>
                        <span className="primary">{Math.round(p.avg_sodium_mg).toLocaleString()}</span>
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
                          <span className="primary">{Math.round(p.today.total_sodium_mg).toLocaleString()}</span>
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
