// Mirrors backend/app/salinity.py.

import type { Bite } from '../types';

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

/** The serving a label's sodium claim is stated against, mL. Mirrors backend/app/labels.py. */
export const REFERENCE_SERVING_ML = 240;

/** A sodium figure as people read one: whole milligrams, grouped. No unit. */
export function fmtMg(n: number): string {
  return Math.round(n).toLocaleString();
}

/** Salinity in g/L as percent salt, the way every view prints it: "0.62%". */
export function fmtSaltPct(g_l: number): string {
  return `${(g_l / 10).toFixed(2)}%`;
}

/**
 * Where a bite's portion came from, said the way the data says it.
 *
 * The range on every sodium figure comes from the portion, so the sentence
 * beside it must not claim a calibration that has not happened. Until someone
 * weighs twenty scoops (docs/calibration.md) every bite is `default`.
 */
export function portionNote(source: Bite['volume_source'] | undefined): string {
  if (source === 'user_calibrated') return 'the portion is a calibrated scoop, not weighed';
  if (source === 'load_cell') return 'the portion was weighed';
  return 'the portion is a default scoop estimate; this spoon has not been calibrated';
}

const QUARTERS = ['', '¼', '½', '¾'];

/**
 * A volume as a kitchen says it: quarter cups of 240 mL, millilitres below a
 * quarter cup.
 *
 * Rounded DOWN, never to nearest. Its one use is "how much of this still fits
 * under the limit", and 1.9 cups said as "about 2 cups" would invite the
 * patient over it.
 */
export function cupsText(ml: number): string {
  if (ml < 60) {
    const to5 = Math.floor(ml / 5) * 5;
    return to5 < 5 ? 'less than 5 mL' : `about ${to5} mL`;
  }
  const quarters = Math.floor(ml / (REFERENCE_SERVING_ML / 4));
  if (quarters > 32) return 'more than 8 cups';
  const whole = Math.floor(quarters / 4);
  const text = `${whole > 0 ? whole : ''}${QUARTERS[quarters % 4]}`;
  return `about ${text} ${quarters > 4 ? 'cups' : 'cup'}`;
}
