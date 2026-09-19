import { PROBE_TEMP_MAX_C, QUALITY_THRESHOLD, Sample } from '../types';
import { ecRelativeError } from '../lib/sodium';
import * as sev from '../lib/severity';
import { Chip } from './Chip';

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
 * Instrument panel. Most of what it reports is ambient - the probe is in air
 * between bites, samples are correctly excluded - so most of it is uncoloured.
 * See src/lib/severity.ts for why.
 */
export function SensorStatus({
  connected, latest, lastError, lastSubmergedTempC, lastSubmergedInRange,
}: Props) {
  const quality = latest?.quality ?? 0;
  const counting = (latest?.submerged ?? false)
    && (latest?.temp_in_range ?? false)
    && quality >= QUALITY_THRESHOLD;
  const ec = latest?.ec25_ms_cm ?? 0;
  const relErr = ec > 0.3 ? ecRelativeError(ec) : null;

  return (
    <section className="card">
      <h2>Sensor</h2>
      <p className="cap">
        Detector: {STATE_LABEL[latest?.state ?? 'IDLE'] ?? latest?.state}
        {' · '}probe rated 0–{PROBE_TEMP_MAX_C} °C
      </p>

      <div className="pill-row">
        <Chip indicator={sev.connection(connected)} />
        <Chip indicator={sev.probeRange(lastSubmergedInRange)} />
        <Chip indicator={sev.submersion(latest?.submerged ?? false)} />
        <Chip indicator={sev.capture(counting)} />
      </div>

      {lastError && <p className="note">Last refusal: {lastError}</p>}

      <div className="rule" />

      <div className="readouts" style={{ marginTop: 0 }}>
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

      <div style={{ marginTop: 14 }}>
        <div className="readout">
          <div className="label">Reading quality · {(quality * 100).toFixed(0)}%</div>
        </div>
        <div className="quality-track">
          <div className="quality-fill" style={{ width: `${Math.round(quality * 100)}%` }} />
        </div>
      </div>
    </section>
  );
}
