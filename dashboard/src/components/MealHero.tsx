import { MealTotals } from '../types';
import * as sev from '../lib/severity';
import { Chip, Fact } from './Chip';

interface Props {
  totals: MealTotals | null;
  activeMealId: number | null;
  /** The patient's daily target, set by their care team. */
  targetMg: number;
}

/**
 * The headline. A single number with a comparison beats any chart — "how much
 * salt is in this meal" has one value, not a shape.
 *
 * The range is shown, always. Scoop volume is estimated, not weighed, and a
 * point estimate with no error bar would overclaim what this hardware can do.
 */
export function MealHero({ totals, activeMealId, targetMg }: Props) {
  const live = activeMealId !== null;
  const sodium = totals?.totalSodium ?? 0;
  const low = totals?.total_sodium_mg_low ?? 0;
  const high = totals?.total_sodium_mg_high ?? 0;
  const bites = totals?.biteCount ?? 0;

  const pctOfLimit = (sodium / targetMg) * 100;

  return (
    <section className="card">
      <h2>Sodium this meal</h2>
      <p className="cap">
        {live ? `Meal #${activeMealId} in progress` : 'No meal in progress'}
        {bites > 0 && ` · ${bites} bite${bites === 1 ? '' : 's'}`}
      </p>

      <p className="hero-value">
        {bites > 0 ? Math.round(sodium).toLocaleString() : '—'}
        <span className="unit">mg</span>
        {bites > 0 && sodium > 0 && (
          <span style={{ fontSize: '0.5em', fontWeight: 'normal', color: 'var(--text-subtle)', marginLeft: '8px' }}>
            (±{Math.round(((high - sodium) / sodium) * 100)}%)
          </span>
        )}
      </p>

      {bites > 0 && (
        <p className="hero-range">
          Range <strong>{Math.round(low).toLocaleString()}–{Math.round(high).toLocaleString()} mg</strong>
          {' '}· Confidence bounds derived from calibrated volume variance.
        </p>
      )}

      <div className="pill-row" style={{ marginTop: 14 }}>
        <Chip indicator={sev.mealVerdict(pctOfLimit)} />
        <Fact>{pctOfLimit.toFixed(0)}% of the {targetMg.toLocaleString()} mg daily target</Fact>
      </div>

      <p className="hero-sub">
        {bites > 0
          ? <>Measured as <strong style={{ color: 'var(--text-primary)' }}>NaCl-equivalent salinity</strong>.
              Conductivity reads all ions, not sodium alone.</>
          : 'Dip the spoon to log a bite. The liquid must be between 0 and 40 °C.'}
      </p>
    </section>
  );
}
