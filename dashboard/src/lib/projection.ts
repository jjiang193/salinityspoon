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

import { Bite } from '../types';
import { FDA_DAILY_LIMIT_MG } from './sodium';

/** Bites considered when estimating the current rate. */
const RATE_WINDOW = 6;

export interface Projection {
  /** Mean sodium per bite over the recent window, mg. */
  mgPerBite: number;
  /** Sodium rate, mg per minute. Null until two bites have been logged. */
  mgPerMinute: number | null;
  /** Whole bites remaining before today's total reaches the FDA limit. */
  bitesToLimit: number | null;
  /** Minutes to the limit at the current rate. Null if the rate is unknown. */
  minutesToLimit: number | null;
  /** True once the limit is already passed. */
  overLimit: boolean;
}

export function project(bites: Bite[], consumedTodayMg: number): Projection | null {
  if (bites.length === 0) return null;

  const window = bites.slice(0, RATE_WINDOW);
  const mgPerBite = window.reduce((a, b) => a + b.sodium_mg, 0) / window.length;

  // Gaps come from the device, which measures them between confirmed bites.
  const gaps = window
    .map((b) => b.seconds_since_prev_bite)
    .filter((g): g is number => g != null && g > 0);

  const meanGapS = gaps.length ? gaps.reduce((a, g) => a + g, 0) / gaps.length : null;
  const mgPerMinute = meanGapS ? (mgPerBite / meanGapS) * 60 : null;

  const remaining = FDA_DAILY_LIMIT_MG - consumedTodayMg;
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
