import { Bite, IntakeToday } from '../types';
import { formatMinutes, project } from '../lib/projection';
import { fmtMg } from '../lib/sodium';
import * as sev from '../lib/severity';

interface Props {
  bites: Bite[];
  intake: IntakeToday | null;
  /** Today's total could not be fetched - which is not the same as zero. */
  intakeError: boolean;
  /** The interlock is refusing bites, so there is no rate to project from. */
  suspended: boolean;
  /** A meal is open. Rate and time to limit are only true during one. */
  inMeal: boolean;
  /** Mid-meal and nothing is arriving: the spoon went quiet, or the server did. */
  stalled: 'spoon' | 'server' | null;
}

/**
 * What the LED cannot do.
 *
 * The device handles rhythm - it is in the user's hand. The dashboard projects:
 * at this concentration and this rate, how many more bites before today's limit.
 *
 * Pure arithmetic over measured bites. No claim about eating speed, because the
 * evidence there concerns total energy intake rather than sodium.
 *
 * It projects against the patient's own limit and today's real total, or not at
 * all: with neither to hand it says so instead of counting down from a guess.
 */
export function SodiumProjection({
  bites, intake, intakeError, suspended, inMeal, stalled,
}: Props) {
  const idle = (message: string) => (
    <section className="card">
      <h2>Projection</h2>
      <p className="cap">From measured bites, against today's limit</p>
      <p className="empty">{message}</p>
    </section>
  );

  if (intake === null) {
    return idle(intakeError
      ? "Today's total is unavailable, so nothing is projected."
      : "Loading today's total…");
  }
  // A countdown that keeps ticking while every bite is refused is a false number.
  if (suspended) return idle('Paused. Nothing is being counted while the liquid is out of range.');
  // The same goes for a spoon nobody can hear: the last rate is not the current one.
  if (stalled === 'spoon')
    return idle('Paused. The spoon is not sending, so there is no current rate.');
  if (stalled === 'server')
    return idle("Paused. The server can't be reached, so there is no current rate.");

  const p = project(bites, intake.total_sodium_mg, intake.sodiumTarget);
  if (!p) return idle('Log a bite to project.');

  // Whether the limit is close, and in what colour, is severity.ts's call.
  const proximity = sev.limitProximity(p.overLimit, p.bitesToLimit);
  const critical = proximity.tier === 'attention';
  const window = Math.min(bites.length, 6);

  return (
    <section className="card">
      <h2>Projection</h2>
      <p className="cap">
        {inMeal
          ? <>Projected from the last {window} bite{window === 1 ? '' : 's'} at today's running total</>
          : <>From the last meal's final {window} bite{window === 1 ? '' : 's'} · no meal in progress</>}
      </p>

      <p className="fig-sm">
        {p.overLimit ? 'Over' : p.bitesToLimit ?? '—'}
        <span>{p.overLimit ? "today's limit reached" : "bites left before today's limit"}</span>
      </p>

      <div className="rule" />

      <div className="readouts">
        <div className="readout">
          <div className="label">Per bite</div>
          <div className="value">{p.mgPerBite.toFixed(1)} <small>mg</small></div>
        </div>
        <div className="readout">
          <div className="label">Rate</div>
          <div className="value">
            {inMeal && p.mgPerMinute !== null ? p.mgPerMinute.toFixed(0) : '—'} <small>mg/min</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Time to limit</div>
          <div className="value">
            {p.overLimit || !inMeal ? '—'
              : p.minutesToLimit !== null ? formatMinutes(p.minutesToLimit)
              : '—'}
          </div>
        </div>
      </div>

      <p className="note" style={{ fontSize: 12 }}>
        Arithmetic over measured bites, not a claim about eating speed — the
        device LED carries the rhythm cue.
      </p>

      {critical && (
        <p className="note attention">
          <span className="mk" data-status={proximity.role}>{sev.markerFor(proximity)}</span>
          {p.overLimit
            ? `Today's intake is past the ${fmtMg(intake.sodiumTarget)} mg limit.`
            : `At this ${inMeal ? 'rate' : 'concentration'} today's limit arrives within ${p.bitesToLimit} more bites.`}
        </p>
      )}
    </section>
  );
}
