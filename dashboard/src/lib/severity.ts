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
  // feed mid-meal does. It is the dashboard's link to the backend: whether the
  // spoon itself is sending is what the Sensor card reports.
  return connected
    ? { tier: 'ambient', label: 'Live feed connected' }
    : { tier: 'attention', label: 'Live feed disconnected', role: 'critical' };
}

export function probeRange(inRange: boolean | null): Indicator {
  // The one state that stops the product working. Always attention when false.
  if (inRange === null) return { tier: 'ambient', label: 'Liquid not yet measured' };
  return inRange
    ? { tier: 'ambient', label: 'Liquid in range' }
    : { tier: 'attention', label: 'Liquid too hot', role: 'critical' };
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
  if (pctOfLimit >= 100)
    return { tier: 'attention', label: `${pctOfLimit.toFixed(0)}% of daily target`, role: 'critical' };
  if (pctOfLimit >= 80)
    return { tier: 'attention', label: `${pctOfLimit.toFixed(0)}% of daily target`, role: 'warning' };
  return { tier: 'ambient', label: `${pctOfLimit.toFixed(0)}% of daily target` };
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
export function rosterStatus(s: {
  pctToday: number;
  pctAvg: number | null;
  daysSinceLog: number | null;
  flaggedMeals: number;
  upwardDrift: boolean;
  driftPct: number | null;
}): Indicator {
  if (s.pctToday >= 100)
    return { tier: 'attention', label: 'Over target today', role: 'critical' };
  if (s.pctAvg !== null && s.pctAvg >= 100)
    return { tier: 'attention', label: 'Above target', role: 'warning' };
  if (s.flaggedMeals > 0)
    return {
      tier: 'attention', role: 'warning',
      label: `Label flag · ${s.flaggedMeals} meal${s.flaggedMeals === 1 ? '' : 's'}`,
    };
  if (s.daysSinceLog === null)
    return { tier: 'ambient', label: 'No data yet' };
  // A lapsed patient's drift is a comparison of stale weeks; the lapse is the news.
  if (s.upwardDrift && s.daysSinceLog < LAPSE_DAYS)
    return {
      tier: 'attention', role: 'warning',
      label: `Trending up · +${(s.driftPct ?? 0).toFixed(0)}%`,
    };
  if (s.daysSinceLog >= LAPSE_DAYS)
    return { tier: 'attention', label: `No log for ${s.daysSinceLog} days`, role: 'warning' };
  if (s.pctAvg !== null && s.pctAvg >= 90)
    return { tier: 'advisory', label: 'Near target' };
  return { tier: 'ambient', label: 'Within target' };
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

export function mealVerdict(pctOfLimit: number): Indicator {
  if (pctOfLimit >= 35) return { tier: 'attention', label: 'high sodium', role: 'warning' };
  if (pctOfLimit >= 20) return { tier: 'advisory', label: 'moderate sodium' };
  return { tier: 'ambient', label: 'low sodium' };
}

export function labelSeverity(severity: 'none' | 'info' | 'warning'): Tier {
  // A label mismatch is the whole point of the potassium flag, so it keeps its
  // colour. A consistent label does not need one.
  return severity === 'warning' ? 'attention' : severity === 'info' ? 'advisory' : 'ambient';
}

export function pace(p: string): Indicator {
  // Six bite rows each carrying a coloured chip was the single biggest source
  // of colour noise. Only "too fast" is worth flagging.
  if (p === 'red') return { tier: 'attention', label: 'fast', role: 'warning' };
  if (p === 'yellow') return { tier: 'advisory', label: 'brisk' };
  if (p === 'green') return { tier: 'ambient', label: 'steady' };
  return { tier: 'ambient', label: '—' };
}
