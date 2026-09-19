import { PROBE_TEMP_MAX_C, QUALITY_THRESHOLD, Sample } from '../types';
import { ecRelativeError } from '../lib/sodium';

interface Props {
  connected: boolean;
  latest: Sample | null;
  lastError: string | null;
  lastSubmergedTempC: number | null;
  lastSubmergedInRange: boolean | null;
}

const STATE_LABEL: Record<string, string> = {
  IDLE: 'Waiting', WETTING: 'Wetting', CAPTURE: 'Capturing',
  CONFIRM: 'Confirming', LOG: 'Logging', ABORT: 'Aborted',
};

/**
 * Makes the sensor fusion legible. The point to take away: the MPU-6050 is not
 * decoration, it is the gate deciding which EC readings count — and the
 * DS18B20 is the interlock deciding whether any reading is valid at all.
 */
export function SensorStatus({
  connected, latest, lastError, lastSubmergedTempC, lastSubmergedInRange,
}: Props) {
  const quality = latest?.quality ?? 0;
  // The probe's rating is about the LIQUID. Reporting air temperature here
  // would show a reassuring green pill while the soup is still boiling.
  const tempOk = lastSubmergedInRange !== false;
  const counts = (latest?.submerged ?? false)
    && (latest?.temp_in_range ?? false)
    && quality >= QUALITY_THRESHOLD;
  const ec = latest?.ec25_ms_cm ?? 0;
  const relErr = ec > 0.3 ? ecRelativeError(ec) : null;

  return (
    <section className="card">
      <h2>Sensor state</h2>
      <p className="caption">
        Detector: {STATE_LABEL[latest?.state ?? 'IDLE'] ?? latest?.state}
      </p>

      <div className="pill-row">
        <span className="pill" data-status={connected ? 'good' : 'critical'}>
          <span className="dot">{connected ? '●' : '■'}</span>
          {connected ? 'Spoon connected' : 'Disconnected'}
        </span>
        <span className="pill" data-status={
          lastSubmergedInRange === null ? '' : tempOk ? 'good' : 'critical'
        }>
          <span className="dot">
            {lastSubmergedInRange === null ? '◆' : tempOk ? '●' : '■'}
          </span>
          {lastSubmergedInRange === null ? 'Liquid not yet measured'
            : tempOk ? `Liquid in range (≤ ${PROBE_TEMP_MAX_C} °C)`
                     : 'Liquid too hot'}
        </span>
        <span className="pill" data-status={latest?.submerged ? 'good' : 'warning'}>
          <span className="dot">{latest?.submerged ? '●' : '▲'}</span>
          {latest?.submerged ? 'Submerged' : 'In air'}
        </span>
        <span className="pill" data-status={counts ? 'good' : 'warning'}>
          <span className="dot">{counts ? '●' : '▲'}</span>
          {counts ? 'Reading counts' : 'Reading excluded'}
        </span>
      </div>

      {lastError && (
        <p className="hero-sub" style={{ marginTop: 14 }}>
          Last refusal: {lastError}
        </p>
      )}

      <div style={{ marginTop: 18 }}>
        <div className="readout">
          <div className="label">Reading quality</div>
          <div className="value">{(quality * 100).toFixed(0)}<small>%</small></div>
        </div>
        <div className="quality-track">
          <div className="quality-fill" style={{ width: `${Math.round(quality * 100)}%` }} />
        </div>
      </div>

      <div className="readouts" style={{ marginTop: 20 }}>
        <div className="readout">
          <div className="label">EC @ 25 °C</div>
          <div className="value">{latest ? ec.toFixed(2) : '—'} <small>mS/cm</small></div>
        </div>
        <div className="readout">
          <div className="label">Liquid temp</div>
          <div className="value">
            {lastSubmergedTempC != null ? lastSubmergedTempC.toFixed(1) : '—'} <small>°C</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Salt</div>
          <div className="value">
            {latest ? (latest.salinity_g_l / 10).toFixed(3) : '—'} <small>% w/v</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Sensor error</div>
          <div className="value">
            {relErr !== null ? `±${(relErr * 100).toFixed(0)}` : '—'} <small>%</small>
          </div>
        </div>
      </div>
    </section>
  );
}
