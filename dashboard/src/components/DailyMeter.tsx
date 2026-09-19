import { IntakeToday } from '../types';
import * as sev from '../lib/severity';
import { Chip } from './Chip';

/**
 * A meter, not a chart: one value against one threshold.
 *
 * The threshold is the patient's own target, set by their care team. The FDA's
 * 2,300 mg and the AHA's 1,500 mg are population figures; a heart-failure
 * patient on a 1,500 mg restriction who is shown a bar that fills at 2,300 has
 * been shown the wrong bar.
 */
export function DailyMeter({ intake }: { intake: IntakeToday | null }) {
  if (!intake || (intake.bite_count === 0 && intake.manual_count === 0)) {
    return (
      <section className="card">
        <h2>Today's sodium</h2>
        <p className="empty">Nothing logged today.</p>
      </section>
    );
  }

  const target = intake.sodiumTarget;
  const pct = Math.min(intake.pct_of_target, 100);
  // The AHA ideal is only worth marking when it sits inside the bar.
  const idealMarkerPct = intake.aha_ideal_limit_mg < target
    ? (intake.aha_ideal_limit_mg / target) * 100
    : null;

  const load = sev.dailyLoad(intake.pct_of_target);
  // The bar itself still carries colour at every level - it is the one place a
  // continuous magnitude is encoded, so a neutral bar would lose information.
  const barRole =
    intake.pct_of_target >= 100 ? 'critical'
    : intake.pct_of_target >= 80 ? 'warning'
    : 'good';

  return (
    <section className="card">
      <h2>Today's sodium</h2>
      <p className="cap">
        {intake.bite_count} measured bite{intake.bite_count === 1 ? '' : 's'} ·{' '}
        {intake.manual_count} self-reported item{intake.manual_count === 1 ? '' : 's'}
      </p>

      <div className="readouts">
        <div className="readout">
          <div className="label">Measured</div>
          <div className="value">
            {Math.round(intake.measured_sodium_mg).toLocaleString()} <small>mg (±10%)</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Self-reported</div>
          <div className="value">
            {Math.round(intake.manual_sodium_mg).toLocaleString()} <small>mg</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Total</div>
          <div className="value">
            {Math.round(intake.total_sodium_mg).toLocaleString()} <small>mg</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Remaining</div>
          <div className="value">
            {Math.max(0, Math.round(target - intake.total_sodium_mg)).toLocaleString()}{' '}
            <small>mg</small>
          </div>
        </div>
      </div>

      <div className="meter">
        <div className="meter-track">
          <div className="meter-fill" style={{ width: `${pct}%`, background: `var(--status-${barRole})` }} />
          {idealMarkerPct !== null && (
            <div className="meter-marker" style={{ left: `${idealMarkerPct}%` }}
                 title={`AHA ideal limit: ${intake.aha_ideal_limit_mg} mg`} />
          )}
        </div>
        <div className="meter-legend">
          <span>0</span>
          {idealMarkerPct !== null && <span>AHA ideal 1,500</span>}
          <span>Target {target.toLocaleString()} · set by care team</span>
        </div>
      </div>

      <div className="pill-row" style={{ marginTop: 14 }}>
        <Chip indicator={load} />
      </div>
    </section>
  );
}
