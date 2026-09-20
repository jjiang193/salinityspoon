import { PROBE_TEMP_MAX_C, PROBE_TEMP_MIN_C } from '../types';

interface Props {
  /** Temperature of the last reading taken in the liquid. */
  tempC: number | null;
  /** A patient needs to know what to do; the Live view, what the probe did. */
  audience: 'patient' | 'instrument';
}

/**
 * The temperature interlock, said out loud.
 *
 * Render it only while the last reading taken in the liquid was out of range.
 * It is the same state as sev.probeRange's critical chip, so it carries the
 * same tier - it used to be amber beside a red chip. It explains the refusal
 * and never offers a way round it: outside 0-40 °C a reading is unsupported,
 * not imprecise.
 */
export function InterlockBanner({ tempC, audience }: Props) {
  const cold = tempC !== null && tempC < PROBE_TEMP_MIN_C;

  if (audience === 'patient') {
    return (
      <div className="banner-critical" role="alert">
        <strong>
          Too {cold ? 'cold' : 'hot'} to measure{tempC !== null ? ` (${tempC.toFixed(0)} °C)` : ''}.
        </strong>{' '}
        Nothing is being counted.{' '}
        {cold
          ? `Let it warm above ${PROBE_TEMP_MIN_C} °C, then dip again.`
          : `Let it cool below ${PROBE_TEMP_MAX_C} °C, then dip again.`}
      </div>
    );
  }

  return (
    <div className="banner-critical" role="alert">
      <strong>
        Liquid is outside the probe's range
        {tempC !== null ? ` — last measured ${tempC.toFixed(1)} °C` : ''}.
      </strong>{' '}
      No bites are logged until it is back within {PROBE_TEMP_MIN_C}–{PROBE_TEMP_MAX_C} °C.
      A reading outside that range is not less precise, it is unsupported.
    </div>
  );
}
