import { PROBE_TEMP_MAX_C, QUALITY_THRESHOLD, Sample } from '../types';
import { DipResult } from '../hooks/useTelemetry';
import { ecRelativeError } from '../lib/sodium';
import * as sev from '../lib/severity';
import { Chip } from './Chip';
import { DipStatus } from './DipStatus';

interface Props {
  connected: boolean;
  /** A sample arrived in the last few seconds. */
  spoonLive: boolean;
  /** Whole seconds since the last sample; null if none was ever seen. */
  silentForS: number | null;
  inMeal: boolean;
  latest: Sample | null;
  lastError: string | null;
  lastSubmergedTempC: number | null;
  lastSubmergedInRange: boolean | null;
  lastDip: DipResult | null;
  dipsNotCounted: number;
}

const STATE_LABEL: Record<string, string> = {
  IDLE: 'Waiting', WETTING: 'Wetting', CAPTURE: 'Capturing',
  CONFIRM: 'Confirming', LOG: 'Logging', ABORT: 'Aborted',
};

/**
 * Instrument panel. Most of what it reports is ambient - the probe is in air
 * between bites, samples are correctly excluded - so most of it is uncoloured.
 * See src/lib/severity.ts for why.
 *
 * Every live value here is only true while samples are arriving. When the spoon
 * goes quiet the last values are withdrawn rather than left standing: a frozen
 * "Confirming · 14.2 mS/cm" is indistinguishable from a working spoon.
 */
export function SensorStatus({
  connected, spoonLive, silentForS, inMeal, latest, lastError,
  lastSubmergedTempC, lastSubmergedInRange, lastDip, dipsNotCounted,
}: Props) {
  const shown = spoonLive ? latest : null;
  const quality = shown?.quality ?? 0;
  const counting = (shown?.submerged ?? false)
    && (shown?.temp_in_range ?? false)
    && quality >= QUALITY_THRESHOLD;
  const ec = shown?.salinityIndex ?? 0;
  const relErr = shown && ec > 0.3 ? ecRelativeError(ec) : null;
  const dim = spoonLive ? '' : ' hero-dim';

  return (
    <section className="card">
      <h2>Sensor</h2>
      <p className="cap">
        {spoonLive
          ? <>Detector: {STATE_LABEL[latest?.state ?? 'IDLE'] ?? latest?.state}</>
          : !connected
            ? <>The server can't be reached, so the spoon can't be heard. Last values are hidden.</>
          : silentForS !== null
            ? <>No samples for {sev.silentFor(silentForS)}. Last values are hidden.</>
            : 'No spoon seen yet.'}
        {spoonLive ? ' · probe' : ' Probe'} rated 0–{PROBE_TEMP_MAX_C} °C
      </p>

      {/* The server's link is the masthead's chip, and is not said twice. The
          rest describe a spoon that is sending: from a quiet one their null
          states ("Liquid not yet measured", over a table of measured bites)
          are false, so they go with the values. */}
      <div className="pill-row">
        <Chip indicator={sev.spoonLink({ live: spoonLive, silentForS, inMeal, connected })} />
        {spoonLive && <Chip indicator={sev.probeRange(lastSubmergedInRange, lastSubmergedTempC)} />}
        {spoonLive && <Chip indicator={sev.submersion(shown?.submerged ?? false)} />}
        {spoonLive && <Chip indicator={sev.capture(counting)} />}
      </div>

      <DipStatus lastDip={lastDip} dipsNotCounted={dipsNotCounted} />
      {lastError && <p className="note">Last refusal: {lastError}</p>}

      <div className="rule" />

      <div className={`readouts${dim}`} style={{ marginTop: 0 }}>
        <div className="readout">
          <div className="label">EC @ 25 °C</div>
          <div className="value">{shown ? ec.toFixed(2) : '—'} <small>mS/cm</small></div>
        </div>
        <div className="readout">
          <div className="label">Liquid temp</div>
          <div className="value">
            {spoonLive && lastSubmergedTempC != null ? lastSubmergedTempC.toFixed(1) : '—'} <small>°C</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Salt</div>
          <div className="value">
            {shown ? (shown.salinity_g_l / 10).toFixed(3) : '—'} <small>% w/v</small>
          </div>
        </div>
        <div className="readout">
          <div className="label">Sensor error</div>
          <div className="value">
            {relErr !== null ? `±${(relErr * 100).toFixed(0)}` : '—'} <small>%</small>
          </div>
        </div>
      </div>

      <div className={dim.trim() || undefined} style={{ marginTop: 14 }}>
        <div className="readout">
          <div className="label">
            Reading quality · {shown ? `${(quality * 100).toFixed(0)}%` : '—'}
          </div>
        </div>
        <div className="quality-track">
          <div className="quality-fill" style={{ width: `${Math.round(quality * 100)}%` }} />
        </div>
      </div>
    </section>
  );
}
