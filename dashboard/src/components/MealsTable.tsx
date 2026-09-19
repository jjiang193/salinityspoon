import { Fragment, useState } from 'react';
import { Bite, MealWithLabel } from '../types';
import { useApi } from '../hooks/useApi';
import { dayAndTime } from '../lib/time';
import * as sev from '../lib/severity';
import { Chip } from './Chip';
import { BiteChart } from './BiteChart';

const VISIBLE = 12;

const secs = (s: number | null) => (s === null ? '—' : `${s.toFixed(0)} s`);

/** One meal's bites, from NaTrack's time-ranged bites endpoint. */
function MealBites({ meal }: { meal: MealWithLabel }) {
  // ISO timestamps carry a '+', which a query string reads as a space.
  const range = `from=${encodeURIComponent(meal.start)}`
    + (meal.end ? `&to=${encodeURIComponent(meal.end)}` : '');
  const { data, loading } = useApi<Bite[]>(`/v1/patients/${meal.patientId}/bites?${range}`);

  if (loading) return <p className="empty">Loading bites…</p>;
  if (!data) return <p className="empty">Could not load this meal's bites.</p>;
  // BiteChart takes newest first, as the live feed delivers them.
  return <BiteChart bites={data.filter((b) => b.mealId === meal.mealId).reverse()} />;
}

/**
 * Meal history: NaTrack's MealSummary rows. Also the table view of the trend
 * chart above it: every bar is readable here as text, with the range each total
 * actually carries. A row opens onto its bites - per bite, per meal, per day,
 * as NaTrack asks of the clinician view.
 *
 * Pace is reported, not judged. "Avg gap" and "Quickest" are arithmetic over
 * the device's own intervals; the Fast pace chip is the device's flag repeated,
 * and it is drawn without colour because the threshold under it is a placeholder.
 *
 * The label column is the one place a past meal earns colour. A product sold as
 * low sodium that measures like ordinary broth is probably using potassium
 * chloride, and for a kidney patient that is the most useful line on the page.
 * It stays a flag: the copy says "possible", and says to check.
 */
export function MealsTable({ meals }: { meals: MealWithLabel[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = meals.filter((m) => m.biteCount > 0).slice(0, VISIBLE);
  const flagged = meals.filter((m) => m.label_flagged).length;

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
        <div className="scroller"><table className="meals">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th className="num">Bites</th>
              <th className="num">Sodium</th>
              <th className="num pad">Range</th>
              <th className="num">Avg gap</th>
              <th className="num pad">Quickest</th>
              <th>Pace</th>
              <th>Label check</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <Fragment key={m.mealId}>
                <tr onClick={() => setOpen(open === m.mealId ? null : m.mealId)}
                    aria-expanded={open === m.mealId}>
                  <td className="primary nowrap">
                    <button className="row-toggle" aria-label="Show this meal's bites">
                      {open === m.mealId ? '▾' : '▸'}
                    </button>
                    {dayAndTime(m.start)}
                  </td>
                  <td>
                    {m.product_name ?? <span className="muted">Not declared</span>}
                    {m.label_claim !== 'none' && (
                      <span className="muted"> · labelled {m.label_claim_label?.toLowerCase()}</span>
                    )}
                  </td>
                  <td className="num">{m.biteCount}</td>
                  <td className="num primary">{Math.round(m.totalSodium).toLocaleString()} mg</td>
                  <td className="num pad nowrap">
                    {Math.round(m.total_sodium_mg_low).toLocaleString()}–
                    {Math.round(m.total_sodium_mg_high).toLocaleString()}
                  </td>
                  <td className="num">{secs(m.avgBiteIntervalSec)}</td>
                  <td className="num pad">{secs(m.minBiteIntervalSec)}</td>
                  <td><Chip indicator={sev.mealPace(m.paceFlag)} /></td>
                  <td>
                    {m.label_claim === 'none' ? <span className="muted">—</span> : (
                      <Chip indicator={m.label_flagged
                        ? { tier: 'attention', role: 'critical', label: m.label_headline ?? 'Flagged' }
                        : { tier: sev.labelSeverity('none'), label: 'Consistent with label' }} />
                    )}
                  </td>
                </tr>
                {open === m.mealId && (
                  <tr className="drill"><td colSpan={9}><MealBites meal={m} /></td></tr>
                )}
              </Fragment>
            ))}
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
