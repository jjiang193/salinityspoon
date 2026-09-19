// Mirrors backend/app/salinity.py.

export const SODIUM_FRACTION_OF_NACL = 0.3934;
export const FDA_DAILY_LIMIT_MG = 2300;
export const AHA_IDEAL_LIMIT_MG = 1500;

/** ±5% of FULL SCALE on a 0–20 mS/cm range, so ±1 mS/cm absolute. */
export const PROBE_EC_FULL_SCALE_ERROR = 1.0;

export type Verdict = 'low' | 'moderate' | 'high' | 'very high';

export function verdictFor(sodiumMg: number): Verdict {
  const pct = (sodiumMg / FDA_DAILY_LIMIT_MG) * 100;
  if (pct < 25) return 'low';
  if (pct < 50) return 'moderate';
  if (pct < 85) return 'high';
  return 'very high';
}

/** Status role, not a series color. Always shipped with an icon and a label. */
export const VERDICT_STATUS: Record<Verdict, { role: string; icon: string }> = {
  low: { role: 'good', icon: '●' },
  moderate: { role: 'good', icon: '●' },
  high: { role: 'warning', icon: '▲' },
  'very high': { role: 'critical', icon: '■' },
};

/**
 * Relative error from the sensor's fixed full-scale spec — it grows as the
 * reading shrinks. 14 mS/cm → ±7%. 5 → ±20%. This is why we measure high in
 * the recommended band rather than diluting.
 */
export function ecRelativeError(ec25: number): number {
  if (ec25 <= 0) return Infinity;
  return PROBE_EC_FULL_SCALE_ERROR / ec25;
}
