/**
 * Severity tiers.
 *
 * The dashboard previously drew sixteen coloured chips from eight independent
 * status systems, all sharing one green/amber/red palette. The consequence was
 * that the temperature interlock - the most consequential state in the product
 * - rendered identically to "the spoon is currently in air". When everything is
 * coloured, nothing reads as urgent.
 *
 * So colour is now rationed. Three tiers:
 *
 *   ambient    something true and expected. No colour. Most state lives here.
 *   advisory   slightly off, no action needed yet. Muted marker only.
 *   attention  a human needs to do something. Colour, icon and label.
 *
 * Adding a new coloured indicator means justifying why it belongs in
 * `attention` rather than reaching for a status colour by reflex.
 */

import { PROBE_TEMP_MIN_C } from '../types';

export type Tier = 'ambient' | 'advisory' | 'attention';

export interface Indicator {
  tier: Tier;
  label: string;
  /** Only meaningful at the attention tier. */
  role?: 'good' | 'warning' | 'critical';
}

export const MARKER: Record<Tier, string> = {
  ambient: '·',
  advisory: '◆',
  attention: '▲',
};

export function markerFor(ind: Indicator): string {
  if (ind.tier !== 'attention') return MARKER[ind.tier];
  return ind.role === 'critical' ? '■' : ind.role === 'good' ? '●' : '▲';
}

// --- The indicators themselves ----------------------------------------------
// Each one states why it sits where it does, so the reasoning survives edits.

export function connection(connected: boolean): Indicator {
  // Being connected is the expected case, so it earns no colour. Losing the
  // server does: nothing on the page can be trusted to be current. This is the
  // dashboard's link to the backend and is labelled as that - it never
  // described the spoon. Whether the spoon is sending is spoonLink, below.
  return connected
    ? { tier: 'ambient', label: 'Server connected' }
    : { tier: 'attention', label: 'Server unreachable', role: 'critical' };
}

export function spoonLink(s: {
  live: boolean;
  /** Whole seconds since the last sample. Null: none seen this session. */
  silentForS: number | null;
  inMeal: boolean;
  /** The session socket is open. Omitted means it is. */
  connected?: boolean;
}): Indicator {
  // With the server unreachable the spoon cannot be heard at all. That is the
  // connection chip's fault to report, in its colour; a second critical chip
  // blaming the spoon would be a false one.
  if (s.connected === false) return { tier: 'ambient', label: 'Spoon cannot be heard' };
  // A spoon that is sending is the expected case: no colour.
  if (s.live) return { tier: 'ambient', label: 'Spoon sending' };
  // Never seen is not a fault. The spoon may simply not be switched on yet.
  if (s.silentForS === null) return { tier: 'ambient', label: 'No spoon seen yet' };
  // Silent in the middle of a meal is attention, and critical. Every dip is
  // being lost while it lasts, and every live value on the page is the last
  // one rather than the current one - a frozen spoon is otherwise
  // indistinguishable from a working one. It is the same order of failure as
  // the temperature interlock (nothing is being counted) and someone can act
  // on it at once: check the spoon is switched on. So it reuses the existing
  // critical role rather than earning a colour of its own.
  if (s.inMeal)
    return { tier: 'attention', label: `Spoon silent for ${silentFor(s.silentForS)}`, role: 'critical' };
  // Between meals a spoon in a drawer is expected. Nothing is being lost.
  return { tier: 'ambient', label: 'Spoon not sending' };
}

/** "42 s", then whole minutes from 60 s. Shared so chip and prose agree. */
export function silentFor(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min` : `${seconds} s`;
}

export function probeRange(inRange: boolean | null, tempC: number | null = null): Indicator {
  // The one state that stops the product working. Always attention when false.
  // The range has two ends; iced broth is refused as firmly as hot soup.
  if (inRange === null) return { tier: 'ambient', label: 'Liquid not yet measured' };
  if (inRange) return { tier: 'ambient', label: 'Liquid in range' };
  const cold = tempC !== null && tempC < PROBE_TEMP_MIN_C;
  return { tier: 'attention', label: cold ? 'Liquid too cold' : 'Liquid too hot', role: 'critical' };
}

export function submersion(submerged: boolean): Indicator {
  // Between bites the probe is supposed to be in air. That is not a warning.
  return { tier: 'ambient', label: submerged ? 'Submerged' : 'In air' };
}

export function capture(counting: boolean): Indicator {
  // Likewise: most samples are correctly excluded. Only worth noting, not
  // worth alarming about.
  return counting
    ? { tier: 'advisory', label: 'Capturing' }
    : { tier: 'ambient', label: 'Not capturing' };
}

export function dailyLoad(pctOfLimit: number): Indicator {
  // Crossing the daily limit is genuinely actionable; being under it is not.
  // Floored, not rounded: 1,495 of 1,500 is 99 %, and "100% of daily limit"
  // beside "5 mg left" is two answers.
  const label = `${Math.floor(pctOfLimit)}% of daily limit`;
  if (pctOfLimit >= 100) return { tier: 'attention', label, role: 'critical' };
  if (pctOfLimit >= 80) return { tier: 'attention', label, role: 'warning' };
  return { tier: 'ambient', label };
}

/** Days without a log before a clinician should hear about it. */
export const LAPSE_DAYS = 3;

/**
 * One chip per roster row, so a clinician can sort a panel by eye.
 *
 * A roster is where colour rationing matters most: five patients each wearing
 * three coloured chips is the sixteen-chip problem again, one level up. So a
 * row gets exactly one indicator - the most pressing thing true of it - and a
 * patient who is simply on target gets no colour at all.
 *
 * Order is by what a clinician can act on soonest. Over target *today* can
 * still be changed at dinner. A high weekly average is the reason the patient
 * is being monitored. A label flag outranks a lapse because it can be true of a
 * patient whose sodium looks perfect - a low-sodium product that measures like
 * ordinary broth is probably potassium chloride, and the sodium columns will
 * never show it. Upward drift is NaTrack's flag: this week's mean well above
 * last week's, in a patient still under target - the one case where acting
 * early is possible. A lapse in logging means every other number on the row is
 * stale, which is its own reason to call.
 */
export function rosterStatus(s: RosterInput): Indicator {
  // Derived from the first reason, so every threshold exists once - in
  // rosterReasons, below - and a chip cannot disagree with the text beside it.
  const first = rosterReasons(s)[0];
  switch (first?.key) {
    case 'over-today':
      return { tier: 'attention', label: 'Over target today', role: 'critical' };
    case 'above-avg':
      return { tier: 'attention', label: 'Above target', role: 'warning' };
    case 'label-flag':
      return {
        tier: 'attention', role: 'warning',
        label: `Label flag · ${s.flaggedMeals} meal${s.flaggedMeals === 1 ? '' : 's'}`,
      };
    case 'trending-up':
      return {
        tier: 'attention', role: 'warning',
        label: `Trending up · +${(s.driftPct ?? 0).toFixed(0)}%`,
      };
    case 'lapsed':
      return { tier: 'attention', label: `No log for ${s.daysSinceLog} days`, role: 'warning' };
  }
  if (s.daysSinceLog === null)
    return { tier: 'ambient', label: 'No data yet' };
  if (s.pctAvg !== null && s.pctAvg >= 90)
    return { tier: 'advisory', label: 'Near target' };
  return { tier: 'ambient', label: 'Within target' };
}

export interface RosterInput {
  pctToday: number;
  pctAvg: number | null;
  daysSinceLog: number | null;
  flaggedMeals: number;
  upwardDrift: boolean;
  driftPct: number | null;
  /** Full days the average runs over; only the reason text says it. */
  windowDays: number;
}

export type ReasonKey = 'over-today' | 'above-avg' | 'label-flag' | 'trending-up' | 'lapsed';

/**
 * Every reason a patient surfaced, in rosterStatus's order, each with its figure.
 *
 * The chip says the most pressing one; a patient over target today can also be
 * trending up and carrying a label flag, and the clinician should not have to
 * find that out by reading three tables. Reasons are text - never a second
 * chip and never a colour path. The roster's tiles count and filter on these
 * keys, so a patient a tile counts is always a patient the filter finds.
 */
export function rosterReasons(s: RosterInput): { key: ReasonKey; text: string }[] {
  const out: { key: ReasonKey; text: string }[] = [];
  if (s.pctToday >= 100)
    out.push({ key: 'over-today', text: `over target today (${s.pctToday.toFixed(0)}%)` });
  if (s.pctAvg !== null && s.pctAvg >= 100)
    out.push({
      key: 'above-avg',
      text: `above target on the ${s.windowDays}-day average (${s.pctAvg.toFixed(0)}%)`,
    });
  if (s.flaggedMeals > 0)
    out.push({
      key: 'label-flag',
      text: `label flag on ${s.flaggedMeals} meal${s.flaggedMeals === 1 ? '' : 's'}`,
    });
  if (s.daysSinceLog === null) return out;
  // A lapsed patient's drift is a comparison of stale weeks; the lapse is the news.
  if (s.upwardDrift && s.daysSinceLog < LAPSE_DAYS)
    out.push({
      key: 'trending-up',
      text: `trending up +${(s.driftPct ?? 0).toFixed(0)}% on the week before`,
    });
  if (s.daysSinceLog >= LAPSE_DAYS)
    out.push({ key: 'lapsed', text: `no log for ${s.daysSinceLog} days` });
  return out;
}

/** Sort key for the roster: most pressing first. */
export function urgency(ind: Indicator): number {
  if (ind.tier === 'attention') return ind.role === 'critical' ? 0 : 1;
  return ind.tier === 'advisory' ? 2 : 3;
}

export function mealPace(paceFlag: boolean): Indicator {
  // NaTrack's paceFlag: most of the meal's bites were flagged fast by the
  // device. Reported, not coloured - the thresholds under it are placeholders,
  // and the evidence on eating speed concerns energy intake, not sodium.
  return paceFlag
    ? { tier: 'advisory', label: 'Fast pace' }
    : { tier: 'ambient', label: 'Steady' };
}

export function mealInProgress(): Indicator {
  // Eating is what the spoon is for. Worth noting on a roster, never alarming.
  return { tier: 'advisory', label: 'In a meal now' };
}

// There is no per-meal "low / moderate / high sodium" verdict. "Low sodium" is
// a regulated label term in this product's own vocabulary (backend/app/labels.py)
// and the chip once said it of a bowl flagged for breaching that very claim.
// The share of the daily limit is printed as a plain fact instead.

export function labelSeverity(severity: 'none' | 'info' | 'warning'): Tier {
  // A label mismatch is the whole point of the potassium flag, so it keeps its
  // colour. A consistent label does not need one.
  return severity === 'warning' ? 'attention' : severity === 'info' ? 'advisory' : 'ambient';
}

/**
 * A label check as one indicator. Every table and card that shows a label check
 * takes its chip from here, so the same check cannot be two colours.
 *
 * Only a flag - measuring at twice the claim or more - earns colour, and it is
 * critical: a product sold as low sodium that measures like ordinary broth is
 * probably potassium chloride, which for a kidney patient is the most useful
 * line on the page and something to act on (read the ingredients) today. Over
 * the claim but under the flag is advisory: true, worth seeing, not yet worth a
 * call. It is never "consistent".
 *
 * rosterStatus words the same fact at the warning role, deliberately: there it
 * is a count over past meals competing with four other reasons for a row's one
 * chip, and critical on the roster is kept for what can still be changed today.
 */
export function labelCheck(severity: 'none' | 'info' | 'warning', label: string): Indicator {
  const tier = labelSeverity(severity);
  return tier === 'attention' ? { tier, label, role: 'critical' } : { tier, label };
}

/** A product's flagged meals, for a list of sources. Same tier as the flag itself. */
export function labelFlagCount(flagged: number, of: number): Indicator {
  return labelCheck('warning', `Label flag · ${flagged} of ${of}`);
}

/** Bites left at or under which the projection says the limit is close. */
export const LIMIT_CLOSE_BITES = 5;

export function limitProximity(overLimit: boolean, bitesToLimit: number | null): Indicator {
  // Past today's limit, or within a few bites of it, is the one thing the
  // projection exists to say in time. Same threshold and role as dailyLoad's
  // 100 %: the day's limit is the clinician's line, not ours.
  if (overLimit) return { tier: 'attention', label: "Past today's limit", role: 'critical' };
  if (bitesToLimit !== null && bitesToLimit <= LIMIT_CLOSE_BITES)
    return { tier: 'attention', label: 'Limit close', role: 'critical' };
  return { tier: 'ambient', label: 'Under limit' };
}

export function pace(p: string): Indicator {
  // The device's own per-bite pace, named after its LED. Reported, not
  // coloured, like mealPace above: the thresholds under it are placeholders,
  // and no threshold on eating speed is ours to claim.
  if (p === 'red') return { tier: 'advisory', label: 'fast' };
  if (p === 'yellow') return { tier: 'advisory', label: 'brisk' };
  if (p === 'green') return { tier: 'ambient', label: 'steady' };
  return { tier: 'ambient', label: '—' };
}
