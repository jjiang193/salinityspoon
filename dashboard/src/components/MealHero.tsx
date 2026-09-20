import { Bite, MealTotals } from '../types';
import { fmtMg, portionNote } from '../lib/sodium';
import { Fact } from './Chip';

interface Props {
  totals: MealTotals | null;
  activeMealId: number | null;
  /** The patient's daily target, set by their care team. Null until it has
   *  loaded: there is no stand-in, so nothing is measured against one. */
  targetMg: number | null;
  /** What the patient said is in the bowl, if they said. */
  mealName: string | null;
  /** Where the bites' portions came from; decides what the range line claims. */
  volumeSource: Bite['volume_source'] | undefined;
  /** Samples are arriving. The Sensor card beside this one says when they are
   *  not, and this card's invitation to dip must not contradict it. */
  spoonSeen: boolean;
}

/**
 * The headline. A single number with a comparison beats any chart — "how much
 * salt is in this meal" has one value, not a shape.
 *
 * The range is shown, always. Scoop volume is estimated, not weighed, and a
 * point estimate with no error bar would overclaim what this hardware can do.
 */
export function MealHero({ totals, activeMealId, targetMg, mealName, volumeSource, spoonSeen }: Props) {
  const live = activeMealId !== null;
  const sodium = totals?.totalSodium ?? 0;
  const low = totals?.total_sodium_mg_low ?? 0;
  const high = totals?.total_sodium_mg_high ?? 0;
  const bites = totals?.biteCount ?? 0;
  const biteCount = `${bites} bite${bites === 1 ? '' : 's'}`;

  const pctOfLimit = targetMg !== null && targetMg > 0 ? (sodium / targetMg) * 100 : null;

  return (
    <section className="card">
      <h2>{!live && bites > 0 ? 'Last meal' : 'Sodium this meal'}</h2>
      <p className="cap">
        {live
          ? `${mealName ?? 'Meal'} in progress${bites > 0 ? ` · ${biteCount}` : ''}`
          : bites > 0 ? `Ended · ${biteCount}` : 'No meal in progress'}
      </p>

      <p className="hero-value">
        {bites > 0 ? fmtMg(sodium) : '—'}
        <span className="unit">mg</span>
      </p>

      {bites > 0 && (
        <p className="hero-range">
          Range <strong>{fmtMg(low)}–{fmtMg(high)} mg</strong>
          {' '}· {portionNote(volumeSource)}
        </p>
      )}

      {/* The share of the limit is a fact, and stays one. A "low sodium" verdict
          chip sat here once - beside a bowl flagged for breaching its "low
          sodium" label. No bites, or no target yet: nothing to take a share of. */}
      {bites > 0 && pctOfLimit !== null && targetMg !== null && (
        <div className="pill-row" style={{ marginTop: 14 }}>
          <Fact>{pctOfLimit.toFixed(0)}% of the {fmtMg(targetMg)} mg daily limit</Fact>
        </div>
      )}

      <p className="hero-sub">
        {bites > 0
          ? <>Measured as <strong style={{ color: 'var(--text-primary)' }}>NaCl-equivalent salinity</strong>.
              Conductivity reads all ions, not sodium alone.</>
          : `${spoonSeen ? 'Dip the spoon' : 'Switch the spoon on, then dip'} to log a bite. `
            + 'The liquid must be between 0 and 40 °C.'}
      </p>
    </section>
  );
}
