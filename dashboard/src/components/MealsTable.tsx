import { Fragment, useState } from 'react';
import { Bite, Meal, MealWithLabel } from '../types';
import { useApi } from '../hooks/useApi';
import { dayAndTime } from '../lib/time';
import { REFERENCE_SERVING_ML, fmtMg, fmtSaltPct } from '../lib/sodium';
import * as sev from '../lib/severity';
import { Chip } from './Chip';
import { BiteChart } from './BiteChart';

const VISIBLE = 12;

/**
 * One meal's bites, asked for by meal id - never by the meal's time range. A
 * meal opened by its own first dip starts on the server's clock, a moment after
 * the device stamped that bite, so `timestamp >= start` lost the first bite and
 * the chart drew one fewer than the row counted.
 */
function MealBites({ meal }: { meal: MealWithLabel }) {
  const { data, loading } = useApi<{ meal: Meal; bites: Bite[] }>(`/api/meals/${meal.mealId}`);

  if (loading) return <p className="empty">Loading bites…</p>;
  if (!data) return <p className="empty">Could not load this meal's bites.</p>;
  // Stored oldest first; BiteChart takes newest first, as the live feed delivers them.
  return <BiteChart bites={data.bites.slice().reverse()} />;
}

/**
 * A meal's label check as one indicator, or null where there is nothing to say.
 *
 * The headline is the server's (backend/app/labels.py), so this table and the
 * live card cannot word the same check two ways. Its tier is severity.ts's
 * (labelCheck): only a flag earns colour, and it is never "consistent".
 */
function labelIndicator(m: MealWithLabel): sev.Indicator | null {
  // "Reduced sodium" is relative to another product: there is no limit to check.
  if (m.label_claim === 'none' || m.label_claim === 'reduced_sodium') return null;
  if (m.label_headline === null) return null;
  return sev.labelCheck(m.label_severity, m.label_headline);
}

/**
 * Meal history: NaTrack's MealSummary rows. Also the table view of the trend
 * chart above it: every bar is readable here as text, with the range each total
 * actually carries. A row opens onto its bites - per bite, per meal, per day,
 * as NaTrack asks of the clinician view.
 *
 * Salinity is what the bowl was - the meal's mean, NaCl-equivalent - beside
 * what was eaten of it. A 900 mg meal of mild broth and a 900 mg meal of three
 * salty spoonfuls are different conversations.
 *
 * Pace is reported, not judged. The average gap and the quickest bite are
 * arithmetic over the device's own intervals; the Fast pace chip is the device's
 * flag repeated, and it is drawn without colour because the threshold under it
 * is a placeholder. An unflagged meal is just its numbers, and a one-bite meal
 * has no interval, so neither gets a chip.
 * The patient variant leaves the column out: pace is a clinician-view number.
 *
 * The label column is the one place a past meal earns colour. A product sold as
 * low sodium that measures like ordinary broth is probably using potassium
 * chloride, and for a kidney patient that is the most useful line on the page.
 * It stays a flag: the copy says "possible", and says to check.
 */
export function MealsTable({ meals, variant = 'clinician' }: {
  meals: MealWithLabel[];
  variant?: 'clinician' | 'patient';
}) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = meals.filter((m) => m.biteCount > 0).slice(0, VISIBLE);
  const flagged = meals.filter((m) => m.label_flagged).length;
  const showPace = variant === 'clinician';

  return (
    <section className="card">
      <h2>Spoon meals</h2>
      <p className="cap">
        Each row is one sitting, measured bite by bite · select a row to see its bites
        {meals.length > shown.length && ` · latest ${shown.length}`}
      </p>

      {shown.length === 0 ? (
        <p className="empty">No meals measured yet.</p>
      ) : (
        <div className="scroller meals-scroll"><table className="meals">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th className="num hide-narrow">Bites</th>
              <th className="num">Sodium</th>
              <th className="num pad" title="Meal mean, NaCl-equivalent salinity">Salinity</th>
              {showPace && <th>Pace</th>}
              <th>Label check</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => {
              const isOpen = open === m.mealId;
              const what = m.product_name ?? 'undeclared meal';
              const label = labelIndicator(m);
              return (
                <Fragment key={m.mealId}>
                  <tr onClick={() => setOpen(isOpen ? null : m.mealId)}>
                    <td className="primary nowrap">
                      {/* No handler of its own: the click bubbles to the row, once. */}
                      <button type="button" className="row-toggle" aria-expanded={isOpen}
                              aria-label={`${isOpen ? 'Hide' : 'Show'} bites for ${what}, ${dayAndTime(m.start)}`}>
                        {isOpen ? '▾' : '▸'}
                      </button>
                      {dayAndTime(m.start)}
                    </td>
                    <td>
                      {m.product_name ?? <span className="muted">Not declared</span>}
                      {m.label_claim !== 'none' && (
                        <span className="muted nowrap claim">
                          <span className="claim-sep"> · </span>labelled {m.label_claim_label?.toLowerCase()}
                        </span>
                      )}
                      {/* On a phone the Label check column scrolls out of sight,
                          and it is the one column that can carry colour. */}
                      {label && m.label_severity !== 'none' && (
                        <div className="status-inline"><Chip indicator={label} /></div>
                      )}
                    </td>
                    <td className="num hide-narrow">{m.biteCount}</td>
                    <td className="num nowrap">
                      <span className="primary">{fmtMg(m.totalSodium)} mg</span>
                      <div className="sub-line">
                        {fmtMg(m.total_sodium_mg_low)}–{fmtMg(m.total_sodium_mg_high)}
                      </div>
                    </td>
                    <td className="num pad nowrap">
                      {m.mean_salinity_g_l === null ? <span className="muted">—</span> : (
                        <>
                          <span className="primary">{fmtSaltPct(m.mean_salinity_g_l)}</span>
                          {m.mg_per_serving !== null && (
                            <div className="sub-line">
                              {fmtMg(m.mg_per_serving)} mg / {REFERENCE_SERVING_ML} mL
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    {showPace && (
                      <td className="nowrap">
                        {m.avgBiteIntervalSec === null ? <span className="muted">—</span> : (
                          <>
                            {m.avgBiteIntervalSec.toFixed(0)} s avg
                            {m.minBiteIntervalSec !== null
                              && ` · ${m.minBiteIntervalSec.toFixed(0)} s quickest`}
                            {/* Only the device's flag earns a chip. A chip that says
                                "Steady" on every row is a box around the default. */}
                            {m.paceFlag && (
                              <div className="chip-line"><Chip indicator={sev.mealPace(true)} /></div>
                            )}
                          </>
                        )}
                      </td>
                    )}
                    <td>
                      {label
                        ? <Chip indicator={label} />
                        : m.label_claim === 'reduced_sodium'
                          ? <span className="muted">No absolute limit to check</span>
                          : <span className="muted">—</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="drill">
                      <td colSpan={showPace ? 7 : 6}>
                        {m.label_detail && <p className="note drill-note">{m.label_detail}</p>}
                        <MealBites meal={m} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table></div>
      )}

      {flagged > 0 && (
        <p className="note">
          A flagged product measures well above its sodium claim. Conductivity reads all
          ions, so the likeliest cause is a potassium-based salt substitute — relevant
          with kidney disease, ACE inhibitors, ARBs or potassium-sparing diuretics.
          This is a flag to check the ingredients, not a finding.
        </p>
      )}
    </section>
  );
}
