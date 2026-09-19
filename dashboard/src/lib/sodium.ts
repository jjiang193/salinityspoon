// Mirrors backend/app/salinity.py.

export const SODIUM_FRACTION_OF_NACL = 0.3934;
export const FDA_DAILY_LIMIT_MG = 2300;
export const AHA_IDEAL_LIMIT_MG = 1500;

/** ±5% of FULL SCALE on a 0–20 mS/cm range, so ±1 mS/cm absolute. */
export const PROBE_EC_FULL_SCALE_ERROR = 1.0;

// Status decisions live in ./severity.ts — one place, so colour cannot be spent
// ad hoc at each call site. This module stays pure arithmetic.

/**
 * Relative error from the sensor's fixed full-scale spec — it grows as the
 * reading shrinks. 14 mS/cm → ±7%. 5 → ±20%. This is why we measure high in
 * the recommended band rather than diluting.
 */
export function ecRelativeError(ec25: number): number {
  if (ec25 <= 0) return Infinity;
  return PROBE_EC_FULL_SCALE_ERROR / ec25;
}
