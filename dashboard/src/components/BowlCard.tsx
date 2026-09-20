import { Bite, IntakeToday, LabelCheck, MealTotals } from '../types';
import { DipResult } from '../hooks/useTelemetry';
import { bowl } from '../lib/projection';
import { cupsText, fmtMg, fmtSaltPct, portionNote, REFERENCE_SERVING_ML } from '../lib/sodium';
import * as sev from '../lib/severity';
import { Chip, Fact } from './Chip';
import { DipStatus } from './DipStatus';

interface Props {
  mealTotals: MealTotals | null;
  /** What the patient said is in the bowl, if they said. */
  mealLabel: { product_name: string | null; label_claim: string } | null;
  labelCheck: LabelCheck | null;
  /** Today's total. Null when it has not loaded or could not be. */
  intake: IntakeToday | null;
  /** The liquid is out of the probe's range: nothing is being counted. */
  suspended: boolean;
  /** The meal is still open. Once it has ended this is the last bowl, not this one. */
  inMeal: boolean;
  /** Where the bites' portions came from; decides what the range line claims. */
  volumeSource: Bite['volume_source'] | undefined;
  lastDip: DipResult | null;
  dipsNotCounted: number;
  /** A spoon is switched on and sending, as far as anyone can tell. */
  spoonSeen: boolean;
}

/**
 * The bowl in front of the patient, in the terms of what is left today.
 *
 * "Can I finish this?" is the question at the table, and everything needed to
 * answer it is already measured: the meal's sodium over its weight is the
 * bowl's salinity, and what is left today divided by that is how much more of
 * it fits. Arithmetic only (lib/projection.ts) - it says how much, never how
 * fast, and it makes no judgement the hero has not already made. No colour
 * here: over the limit is the hero's to say, a contradicted label the alert's.
 *
 * It leads with the decision - how much more fits - and the instrument's
 * reading of the bowl is the note under it. What has been eaten of it, and
 * whether the last dip counted, close the card: they are about this bowl, and
 * in the hero they pushed this card's answer off a phone's first screen.
 *
 * While the bowl's label is flagged the decision line is withheld. The alert
 * above says the reading is probably not sodium; "3 cups more of this fits",
 * computed from that same reading, would answer it in the opposite direction.
 */
export function BowlCard({
  mealTotals, mealLabel, labelCheck, intake, suspended, inMeal,
  volumeSource, lastDip, dipsNotCounted, spoonSeen,
}: Props) {
  const remaining = intake ? intake.sodiumTarget - intake.total_sodium_mg : null;
  const b = mealTotals ? bowl(mealTotals, remaining) : null;
  const bites = mealTotals?.biteCount ?? 0;
  // Checked before the bite count: the first spoonfuls of a bowl started over
  // the limit must not be answered with an invitation to take a few more.
  const reached = remaining !== null && remaining <= 0;
  const note = portionNote(volumeSource);

  // After the meal ends the declared label is gone from the session; the check
  // still knows what the bowl was called.
  const product = mealLabel?.product_name ?? labelCheck?.product_name ?? null;
  const claimed = labelCheck && labelCheck.claim !== 'none' ? labelCheck.claim_label : null;
  const f = b ? fits(b, remaining) : null;
  const flagged = labelCheck?.flagged ?? false;

  return (
    <section className="card">
      <h2>{inMeal ? 'This bowl' : 'Your last bowl'}</h2>
      <p className="cap">
        {product
          ? `${product}${claimed ? ` · labelled ${claimed.toLowerCase()}` : ''}`
          : inMeal ? 'What the spoon has measured so far' : 'What the spoon measured'}
      </p>

      {suspended ? (
        <p className="empty" role="status">
          Paused. Nothing is being counted while the liquid is out of range.
        </p>
      ) : b === null || f === null ? (
        reached ? (
          <p className="note attention">{REACHED}</p>
        ) : (
          <p className="empty">
            {inMeal
              ? <>
                  Take a few spoonfuls to measure this bowl.
                  {!spoonSeen && ' Switch the spoon on first.'}
                  {' '}The liquid must be between 0 and 40 °C.
                </>
              : 'Too few spoonfuls to measure it.'}
          </p>
        )
      ) : (
        <>
          {flagged ? (
            <p className="note">
              {reached && <>{REACHED}{' '}</>}
              How much of this fits is not shown while its label is in question. The spoon
              reads all ions: this bowl reads as {fmtMg(b.mgPerServing)} mg per cup
              ({REFERENCE_SERVING_ML} mL) as NaCl-equivalent salinity
              {labelCheck?.ratio != null && `, about ${labelCheck.ratio.toFixed(0)}× its label`}.
            </p>
          ) : (
            <>
              {f.lead !== null
                ? <p className="fig-sm">{f.lead}<span>{f.text}</span></p>
                : <p className="note attention">{f.text}</p>}
              <p className="note">
                About {fmtMg(b.mgPerServing)} mg sodium per cup ({REFERENCE_SERVING_ML} mL) ·{' '}
                {fmtSaltPct(b.g_l)} salt, as NaCl-equivalent salinity.
              </p>
            </>
          )}

          {labelCheck && labelCheck.claim !== 'none' && !flagged && (
            <div className="pill-row" style={{ marginTop: 12 }}>
              <Chip indicator={sev.labelCheck(labelCheck.severity, labelCheck.headline)} />
              {labelCheck.claim_max_mg !== null && (
                <Fact>
                  {fmtMg(labelCheck.measured_mg_per_serving)} mg vs{' '}
                  {fmtMg(labelCheck.claim_max_mg)} mg per {REFERENCE_SERVING_ML} mL
                </Fact>
              )}
            </div>
          )}

          {!flagged && (
            <p className="note fine">
              Spoonfuls are counted at 1 g per mL, the same assumption the sodium figures use.
            </p>
          )}
        </>
      )}

      {mealTotals && bites > 0 && (
        <>
          <div className="rule" />
          <h3 className="sub-head">{inMeal ? 'This meal so far' : 'Last meal'}</h3>
          <p className="fig-sm">
            {fmtMg(mealTotals.totalSodium)} mg
            <span>
              range {fmtMg(mealTotals.total_sodium_mg_low)}–{fmtMg(mealTotals.total_sodium_mg_high)} mg
              {' '}· {bites} spoonful{bites === 1 ? '' : 's'}
            </span>
          </p>
          <p className="note fine">
            {/* Above, a measured bowl has already said what kind of figure this is. */}
            {(b === null || suspended)
              && <>Measured as <strong>NaCl-equivalent salinity</strong>. </>}
            Conductivity reads all ions, not sodium alone.{' '}
            {note.charAt(0).toUpperCase() + note.slice(1)}.
          </p>
        </>
      )}
      <DipStatus lastDip={lastDip} dipsNotCounted={dipsNotCounted} />
    </section>
  );
}

const REACHED = "Today's limit is reached. Anything more from this bowl goes over it.";

/**
 * The decision line. Said against the limit, from the cautious end of the range.
 * `lead` is the figure when there is one to lead with; without it `text` is a
 * whole sentence.
 */
function fits(
  b: NonNullable<ReturnType<typeof bowl>>, remaining: number | null,
): { lead: string | null; text: string } {
  if (remaining === null || b.mlLeft === null || b.spoonfulsLow === null || b.spoonfulsHigh === null)
    return { lead: null, text: "Today's total is unavailable, so what fits is not shown." };
  if (remaining <= 0)
    return { lead: null, text: REACHED };
  if (b.spoonfulsHigh < 1)
    return { lead: null, text: 'Less than one more spoonful of this fits in what you have left today.' };

  const left = `the ${fmtMg(remaining)} mg you have left today`;
  // Eight cups is more than anyone's bowl; a spoonful count there is noise.
  if (b.mlLeft > 8 * REFERENCE_SERVING_ML)
    return { lead: 'More than 8 cups', text: `of this fits in ${left}` };
  const lo = Math.max(b.spoonfulsLow, 0);
  const count = lo === b.spoonfulsHigh
    ? `${lo} spoonful${lo === 1 ? '' : 's'}`
    : `${lo}–${b.spoonfulsHigh} spoonfuls`;
  const cups = cupsText(b.mlLeft);
  return {
    lead: cups.charAt(0).toUpperCase() + cups.slice(1),
    text: `more of this (${count}) fits in ${left}`,
  };
}
