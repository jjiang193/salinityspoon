import { PROBE_TEMP_MAX_C, PROBE_TEMP_MIN_C } from '../types';
import { DipResult } from '../hooks/useTelemetry';
import { fmtMg } from '../lib/sodium';

interface Props {
  lastDip: DipResult | null;
  dipsNotCounted: number;
}

/** What to say about the last dip. Null when there has not been one. */
export function dipText(lastDip: DipResult | null): string | null {
  if (lastDip === null) return null;
  if (lastDip.counted) return `Last dip counted · +${fmtMg(lastDip.mg)} mg`;
  return lastDip.reason === 'out-of-range'
    ? `Last dip not counted: the liquid is outside ${PROBE_TEMP_MIN_C}–${PROBE_TEMP_MAX_C} °C.`
    : 'Last dip not counted: the spoon could not get a steady reading. '
      + 'Dip again and hold still for a moment.';
}

/** The running tally beside it. Null when every dip has counted. */
export function dipTally(dipsNotCounted: number): string | null {
  if (dipsNotCounted <= 0) return null;
  return `${dipsNotCounted} dip${dipsNotCounted === 1 ? '' : 's'} not counted this meal`;
}

/**
 * "Did that dip count?"
 *
 * A dip the spoon rejects sends nothing at all, so without this line a rejected
 * dip and a broken spoon look the same. Uncoloured on purpose: a dip that did
 * not count is ordinary - dip again - and the states that stop the product
 * (liquid out of range, spoon silent) already have their own critical
 * indicators.
 */
export function DipStatus({ lastDip, dipsNotCounted }: Props) {
  const text = dipText(lastDip);
  const tally = dipTally(dipsNotCounted);

  // Always mounted, so the live region exists before it has something to say;
  // while empty it takes no space (.dip-status:empty).
  return (
    <p className="note dip-status" aria-live="polite">
      {text}
      {tally !== null && (
        <span className="dip-tally">{text !== null ? ' · ' : ''}{tally}</span>
      )}
    </p>
  );
}
