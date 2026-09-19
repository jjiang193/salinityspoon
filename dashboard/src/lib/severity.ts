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
  // spoon mid-meal does.
  return connected
    ? { tier: 'ambient', label: 'Spoon connected' }
    : { tier: 'attention', label: 'Spoon disconnected', role: 'critical' };
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
    return { tier: 'attention', label: `${pctOfLimit.toFixed(0)}% of daily limit`, role: 'critical' };
  if (pctOfLimit >= 80)
    return { tier: 'attention', label: `${pctOfLimit.toFixed(0)}% of daily limit`, role: 'warning' };
  return { tier: 'ambient', label: `${pctOfLimit.toFixed(0)}% of daily limit` };
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
