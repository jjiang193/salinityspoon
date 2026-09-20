import { PROBE_TEMP_MAX_C, Bite } from '../types';
import { ecRelativeError } from '../lib/sodium';
import * as sev from '../lib/severity';

interface Props {
  /** Newest first, as the live session and the history both deliver them. */
  bites: Bite[];
}

/**
 * The instrument panel for a cloud build, read from the last bite.
 *
 * `SensorStatus` reports live samples and withdraws them the moment the spoon
 * goes quiet, because a frozen "Capturing · 14.2 mS/cm" is indistinguishable
 * from a working spoon. That rule is right, and this panel keeps it rather
 * than working around it: no sample ever reaches the cloud, so instead of
 * dressing a bite up as live telemetry, this says plainly that it is the last
 * bite and when it was taken.
 *
 * Every number here was measured. The one thing it cannot tell you is what the
 * probe is doing *now* — which, on the cloud path, nothing can.
 */
export function LastBitePanel({ bites }: Props) {
  const last = bites[0] ?? null;

  if (!last) {
    return (
      <section className="card">
        <h2>Last bite</h2>
        <p className="cap">
          No bites yet. Fill the bowl, wait for the weight to settle, dip the probes,
          then tip it out. Probe rated 0–{PROBE_TEMP_MAX_C} °C.
        </p>
      </section>
    );
  }

  const when = new Date(last.timestamp);
  const agoS = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000));
  const relErr = last.salinityIndex > 0.3 ? ecRelativeError(last.salinityIndex) : null;

  return (
    <section className="card">
      <h2>Last bite</h2>
      <p className="cap">
        Measured {when.toLocaleTimeString()}, {sev.silentFor(agoS)} ago · probe rated
        0–{PROBE_TEMP_MAX_C} °C. The cloud receives fused bites, never raw samples,
        so this is the newest reading that exists here.
      </p>

      <div className="readouts" style={{ marginTop: 0 }}>
        <div className="readout">
          <div className="label">EC @ 25 °C</div>
          <div className="value">{last.salinityIndex.toFixed(2)} <small>mS/cm</small></div>
        </div>
        <div className="readout">
          <div className="label">Liquid temp</div>
          <div className="value">{last.tempC.toFixed(1)} <small>°C</small></div>
        </div>
        <div className="readout">
          <div className="label">Salt</div>
          <div className="value">{(last.salinity_g_l / 10).toFixed(3)} <small>% w/v</small></div>
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
          <div className="label">
            {last.volume_source === 'load_cell' ? 'Weighed' : 'Scoop'} ·{' '}
            {last.weightGrams.toFixed(1)} g · {last.ec_sample_count} EC samples ·
            quality {(last.quality * 100).toFixed(0)}%
          </div>
        </div>
      </div>

      {last.flags?.length ? (
        <p className="note">Flags: {last.flags.join(', ')}.</p>
      ) : null}
    </section>
  );
}
