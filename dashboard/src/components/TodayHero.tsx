import { IntakeToday } from '../types';
import { DipResult } from '../hooks/useTelemetry';
import { fmtMg } from '../lib/sodium';
import * as sev from '../lib/severity';
import { Chip } from './Chip';
import { DipStatus } from './DipStatus';

interface Props {
  intake: IntakeToday | null;
  loading: boolean;
  /** The last fetch failed. With `intake` still set, what shows is stale. */
  error: boolean;
  /** A meal is open or has just ended: BowlCard is on the page, and the meal's
   *  figure, the dip line and what to do next are its to say, not this card's. */
  bowlInPlay: boolean;
  lastDip: DipResult | null;
  dipsNotCounted: number;
  /** Someone else is mid-meal with the spoon: a dip now would be logged to them. */
  spoonBusyElsewhere: boolean;
  /** A spoon is switched on and sending, as far as anyone can tell. */
  spoonSeen: boolean;
}

/**
 * The patient's headline: what is left today.
 *
 * A meter, not a chart: one value against one threshold. The threshold is the
 * patient's own limit, set by their care team. The FDA's 2,300 mg and the AHA's
 * 1,500 mg are population figures; a heart-failure patient on a 1,500 mg
 * restriction who is shown a bar that fills at 2,300 has been shown the wrong
 * bar.
 *
 * It leads with what is LEFT because that is the decision at the table, and it
 * is worded as a limit throughout - nothing here is a goal to reach. Over the
 * limit it says by how much; "0 mg remaining" would hide the one number that
 * matters then. A day that could not be read is never shown as an empty day.
 *
 * It ends at the day. The meal's own figure is BowlCard's: on a phone that
 * block pushed "how much of this bowl fits" a full screen below "what is left",
 * and the two are one question.
 */
export function TodayHero({
  intake, loading, error, bowlInPlay, lastDip, dipsNotCounted, spoonBusyElsewhere, spoonSeen,
}: Props) {
  if (!intake) {
    if (error || !loading) {
      return (
        <section className="card">
          <h2>Today</h2>
          <p className="empty" role="status">
            Can't reach the server right now, so today's numbers are not shown.
          </p>
        </section>
      );
    }
    return (
      <section className="card" aria-busy="true">
        <h2>Left today</h2>
        <p className="hero-value hero-dim">—</p>
        <p className="cap" style={{ margin: '10px 0 0' }} role="status">Loading today's numbers…</p>
      </section>
    );
  }

  const target = intake.sodiumTarget;
  const remaining = target - intake.total_sodium_mg;
  const over = remaining < 0;
  const nothingYet = intake.bite_count === 0 && intake.manual_count === 0;

  const pct = Math.min(intake.pct_of_target, 100);
  // The AHA ideal is only worth marking when it sits inside the bar.
  const idealMarkerPct = intake.aha_ideal_limit_mg < target
    ? (intake.aha_ideal_limit_mg / target) * 100
    : null;

  // Under 80 % the chip would be an uncoloured restatement of the figure above it.
  const load = sev.dailyLoad(intake.pct_of_target);
  // The bar itself still carries colour at every level - it is the one place a
  // continuous magnitude is encoded, so a neutral bar would lose information.
  // Its role is the chip's (severity.ts): one set of thresholds, so they cannot drift.
  const barRole = load.role ?? 'good';

  // The day's range reaches past the limit while the figure above sits under
  // it: by the product's own error bar the patient may already be over.
  const maybeOverBy = !over && intake.total_sodium_mg_high >= target
    ? intake.total_sodium_mg_high - target
    : null;
  // What to do next, which depends on where the spoon is. SessionCard owns the
  // explanation; this line must never contradict it. With the spoon in someone
  // else's meal it says nothing - a dip now would be logged to them - and over
  // the limit it does not invite another bite.
  const dipHint = spoonBusyElsewhere || over ? null
    : spoonSeen ? 'Dip the spoon to log a bite.'
    : 'Switch the spoon on, then dip to log a bite.';

  return (
    <section className="card">
      <h2>{over ? "Over today's limit" : 'Left today'}</h2>
      <p className="hero-value">
        {fmtMg(over ? -remaining : remaining)}
        <span className="unit">mg</span>
      </p>
      <p className="cap" style={{ margin: '8px 0 0' }}>
        {over
          ? `over your ${fmtMg(target)} mg daily limit`
          : `of your ${fmtMg(target)} mg daily limit, set by your care team`}
        {nothingYet && ' · nothing logged yet today'}
      </p>
      {maybeOverBy !== null && (
        <p className="note attention" style={{ marginTop: 6 }}>
          You could already be over: the range of what was measured allows up
          to {fmtMg(maybeOverBy)} mg past the limit.
        </p>
      )}
      {load.tier === 'attention' && (
        <div className="pill-row" style={{ marginTop: 10 }}>
          <Chip indicator={load} />
        </div>
      )}

      <div className="meter" role="img"
           aria-label={`${fmtMg(intake.total_sodium_mg)} of ${fmtMg(target)} milligrams, `
             + `${intake.pct_of_target.toFixed(0)} percent of today's limit`}>
        <div className="meter-track">
          <div className="meter-fill" style={{ width: `${pct}%`, background: `var(--status-${barRole})` }} />
          {idealMarkerPct !== null && (
            <div className="meter-marker" style={{ left: `${idealMarkerPct}%` }} aria-hidden="true" />
          )}
        </div>
        <div className="meter-legend" aria-hidden="true">
          <span>0</span>
          {idealMarkerPct !== null && <span>AHA ideal {fmtMg(intake.aha_ideal_limit_mg)}</span>}
          <span>Limit {fmtMg(target)}</span>
        </div>
      </div>

      <p className="hero-range">
        Eaten today <strong>{fmtMg(intake.total_sodium_mg)} mg</strong>
        {/* Self-reported food carries no range, so a day of only that has none to print. */}
        {intake.total_sodium_mg_high > intake.total_sodium_mg_low
          && <> · range {fmtMg(intake.total_sodium_mg_low)}–{fmtMg(intake.total_sodium_mg_high)}</>}
      </p>
      {/* Two claims of different kinds, side by side and never merged. */}
      <div className="readouts" style={{ marginTop: 12 }}>
        <div className="readout">
          <div className="label">Measured by the spoon</div>
          <div className="value">{fmtMg(intake.measured_sodium_mg)} <small>mg</small></div>
        </div>
        <div className="readout">
          <div className="label">Self-reported</div>
          <div className="value">{fmtMg(intake.manual_sodium_mg)} <small>mg</small></div>
        </div>
      </div>
      {error && (
        <p className="form-note" role="status">
          Couldn't refresh. These are the last numbers received.
        </p>
      )}

      {!bowlInPlay && (
        <>
          {dipHint && <p className="hero-sub">{dipHint} The liquid must be between 0 and 40 °C.</p>}
          <DipStatus lastDip={lastDip} dipsNotCounted={dipsNotCounted} />
        </>
      )}
    </section>
  );
}
