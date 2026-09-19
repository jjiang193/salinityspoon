import { Indicator, markerFor } from '../lib/severity';

/**
 * One chip, rendered according to its tier. Components describe *what a state
 * is* via src/lib/severity.ts and this decides how loudly to say it, so colour
 * cannot be spent ad hoc at each call site.
 */
export function Chip({ indicator }: { indicator: Indicator }) {
  return (
    <span
      className="pill"
      data-tier={indicator.tier}
      data-status={indicator.role ?? undefined}
    >
      <span className="dot">{markerFor(indicator)}</span>
      {indicator.label}
    </span>
  );
}

/** A chip with no state behind it - a plain fact, never coloured. */
export function Fact({ children }: { children: React.ReactNode }) {
  return (
    <span className="pill" data-tier="ambient">
      <span className="dot">·</span>
      {children}
    </span>
  );
}
