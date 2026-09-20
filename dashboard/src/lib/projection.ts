/**
 * Sodium projection.
 *
 * The device LED already handles rhythm - it is in the user's hand, which is
 * the right place for "you are eating too fast". The dashboard does what the
 * LED cannot: arithmetic.
 *
 * Everything here is deliberately pure arithmetic over measured bites. No
 * clinical thresholds about eating speed, because the evidence on slow eating
 * concerns total energy intake and satiety, not sodium - the sodium link runs
 * through total intake and is not ours to claim.
 */

import { Bite, MealTotals } from '../types';
import { REFERENCE_SERVING_ML, SODIUM_FRACTION_OF_NACL } from './sodium';

/** Bites considered when estimating the current rate. */
const RATE_WINDOW = 6;

export interface Projection {
  /** Mean sodium per bite over the recent window, mg. */
  mgPerBite: number;
  /** Sodium rate, mg per minute. Null until two bites have been logged. */
  mgPerMinute: number | null;
  /** Whole bites remaining before today's total reaches the patient's limit. */
  bitesToLimit: number | null;
  /** Minutes to the limit at the current rate. Null if the rate is unknown. */
  minutesToLimit: number | null;
  /** True once the limit is already passed. */
  overLimit: boolean;
}

// limitMg has no default on purpose. The limit is the patient's own; a caller
// that does not have it yet has nothing to project against.
export function project(
  bites: Bite[], consumedTodayMg: number, limitMg: number,
): Projection | null {
  if (bites.length === 0) return null;

  const window = bites.slice(0, RATE_WINDOW);
  const mgPerBite = window.reduce((a, b) => a + b.sodiumEstimate, 0) / window.length;

  // Gaps come from the device, which measures them between confirmed bites.
  const gaps = window
    .map((b) => b.biteIntervalSec)
    .filter((g): g is number => g != null && g > 0);

  const meanGapS = gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : null;
  const mgPerMinute = meanGapS ? (mgPerBite / meanGapS) * 60 : null;

  const remaining = limitMg - consumedTodayMg;
  const overLimit = remaining <= 0;

  const bitesToLimit = overLimit || mgPerBite <= 0
    ? (overLimit ? 0 : null)
    : Math.floor(remaining / mgPerBite);

  const minutesToLimit = overLimit ? 0
    : mgPerMinute && mgPerMinute > 0 ? remaining / mgPerMinute
    : null;

  return { mgPerBite, mgPerMinute, bitesToLimit, minutesToLimit, overLimit };
}

export function formatMinutes(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Spoonfuls before a bowl can be described. Two dips are still mostly noise. */
const BOWL_MIN_BITES = 3;

export interface Bowl {
  /** The bowl so far: weight-averaged NaCl-equivalent salinity, g/L. */
  g_l: number;
  saltPct: number;
  /** mg of sodium in a 240 mL reference serving at that salinity. */
  mgPerServing: number;
  /** Eaten so far, at 1 g = 1 mL - the assumption the sodium figures make. */
  mlEaten: number;
  /** How much more of this bowl fits under today's limit. The three "left"
   *  values are null when today's total is unknown and 0 once it is reached. */
  mlLeft: number | null;
  /** From the top of the per-spoonful range, so the cautious end. */
  spoonfulsLow: number | null;
  spoonfulsHigh: number | null;
}

/**
 * This bowl, in the terms of what is left today.
 *
 * Pure arithmetic over the meal's totals, and the same formula as
 * cohort.label_check on the server: sodium over weight gives the bowl's mean
 * salinity, and mean salinity gives mg per serving. It says how much fits, never
 * how fast to eat it - no claim about eating speed is made here.
 *
 * Null until there is enough to say anything: fewer than three spoonfuls, or
 * nothing weighed.
 */
export function bowl(totals: MealTotals, remainingMg: number | null): Bowl | null {
  if (totals.biteCount < BOWL_MIN_BITES || totals.total_weight_g <= 0) return null;

  const mgPerMl = totals.totalSodium / totals.total_weight_g;
  const g_l = mgPerMl / SODIUM_FRACTION_OF_NACL;
  const base = {
    g_l,
    saltPct: g_l / 10,
    mgPerServing: g_l * SODIUM_FRACTION_OF_NACL * REFERENCE_SERVING_ML,
    mlEaten: totals.total_weight_g,
  };

  if (remainingMg === null)
    return { ...base, mlLeft: null, spoonfulsLow: null, spoonfulsHigh: null };
  if (remainingMg <= 0)
    return { ...base, mlLeft: 0, spoonfulsLow: 0, spoonfulsHigh: 0 };

  const perSpoonHigh = totals.total_sodium_mg_high / totals.biteCount;
  const perSpoonLow = totals.total_sodium_mg_low / totals.biteCount;
  return {
    ...base,
    // A bowl that reads no salt at all never reaches the limit: Infinity, which
    // the card says as "more than 8 cups".
    mlLeft: remainingMg / mgPerMl,
    spoonfulsLow: Math.floor(remainingMg / perSpoonHigh),
    spoonfulsHigh: Math.floor(remainingMg / perSpoonLow),
  };
}
