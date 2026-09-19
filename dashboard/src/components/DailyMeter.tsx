import { IntakeToday } from '../types';
import * as sev from '../lib/severity';
import { Chip } from './Chip';

/**
 * A meter, not a chart: one value against one threshold. The AHA's stricter
 * 1,500 mg ideal is marked so the FDA limit is not read as a target.
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

  const pct = Math.min(intake.pct_of_fda_limit, 100);
  const idealMarkerPct = (intake.aha_ideal_limit_mg / intake.fda_daily_limit_mg) * 100;

  const load = sev.dailyLoad(intake.pct_of_fda_limit);
  // The bar itself still carries colour at every level - it is the one place a
  // continuous magnitude is encoded, so a neutral bar would lose information.
  const barRole =
    intake.pct_of_fda_limit >= 100 ? 'critical'
    : intake.pct_of_fda_limit >= 80 ? 'warning'
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
            {Math.round(intake.measured_sodium_mg).toLocaleString()} <small>mg</small>
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
            {Math.max(0, Math.round(intake.fda_daily_limit_mg - intake.total_sodium_mg)).toLocaleString()}{' '}
            <small>mg</small>
          </div>
        </div>
      </div>

      <div className="meter">
        <div className="meter-track">
          <div className="meter-fill" style={{ width: `${pct}%`, background: `var(--status-${barRole})` }} />
          <div className="meter-marker" style={{ left: `${idealMarkerPct}%` }}
               title={`AHA ideal limit: ${intake.aha_ideal_limit_mg} mg`} />
        </div>
        <div className="meter-legend">
          <span>0</span>
          <span>AHA ideal 1,500</span>
          <span>FDA limit 2,300</span>
        </div>
      </div>

      <div className="pill-row" style={{ marginTop: 14 }}>
        <Chip indicator={load} />
      </div>
    </section>
  );
}
