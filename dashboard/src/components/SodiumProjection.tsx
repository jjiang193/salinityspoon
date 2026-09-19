import { Bite, IntakeToday } from '../types';
import { formatMinutes, project } from '../lib/projection';
import { markerFor } from '../lib/severity';

/**
 * What the LED cannot do.
 *
 * The device handles rhythm - it is in the user's hand. The dashboard projects:
 * at this concentration and this rate, how many more bites before today's limit.
 *
 * Pure arithmetic over measured bites. No claim about eating speed, because the
 * evidence there concerns total energy intake rather than sodium.
 */
export function SodiumProjection({
  bites, intake,
}: { bites: Bite[]; intake: IntakeToday | null }) {
  const p = project(bites, intake?.total_sodium_mg ?? 0, intake?.sodiumTarget);

  if (!p) {
    return (
      <section className="card">
        <h2>Pace</h2>
        <p className="cap">Projection from measured bites</p>
        <p className="empty">Log a bite to project.</p>
      </section>
    );
  }

  const critical = p.overLimit || (p.bitesToLimit !== null && p.bitesToLimit <= 5);
  const marker = markerFor(
    critical
      ? { tier: 'attention', label: '', role: 'critical' }
      : { tier: 'ambient', label: '' },
  );

  return (
    <section className="card">
      <h2>Pace</h2>
      <p className="cap">
        Projected from the last {Math.min(bites.length, 6)} bite
        {Math.min(bites.length, 6) === 1 ? '' : 's'} at today's running total
      </p>

      <p className="fig-sm">
        {p.overLimit ? 'Over' : p.bitesToLimit ?? '—'}
        <span>{p.overLimit ? 'daily target reached' : 'bites to your daily target'}</span>
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
            {p.mgPerMinute !== null ? p.mgPerMinute.toFixed(0) : '—'} <small>mg/min</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Time to target</div>
          <div className="value">
            {p.overLimit ? '—'
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
          <span className="mk">{marker}</span>
          {p.overLimit
            ? `Today's intake is past the ${(intake?.sodiumTarget ?? 2300).toLocaleString()} mg target.`
            : `At this rate today's target arrives within ${p.bitesToLimit} more bites.`}
        </p>
      )}
    </section>
  );
}
