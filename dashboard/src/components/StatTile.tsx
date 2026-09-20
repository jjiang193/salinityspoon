/**
 * A number, its unit, and what it is being compared to.
 *
 * Deliberately has no colour prop. A tile reports; whether the report is bad
 * news is the job of one Chip elsewhere on the screen (src/lib/severity.ts).
 *
 * With `onClick` the tile is a toggle button - the roster's count tiles filter
 * the table under them. Pressed is the UI accent, the same as any other pressed
 * control, and says nothing about the number inside.
 */
export function StatTile({ label, value, unit, note, onClick, pressed }: {
  label: string;
  value: string;
  unit?: string;
  note?: React.ReactNode;
  onClick?: () => void;
  pressed?: boolean;
}) {
  const inner = (
    <>
      <span className="tile-label">
        {/* Its own box, so a long label wraps beside the hint and not around it. */}
        <span>{label}</span>
        {/* The only thing that says a tile can be pressed before it is hovered. */}
        {onClick && <span className="tile-hint" aria-hidden="true">{pressed ? 'Filtering ×' : 'Filter'}</span>}
      </span>
      <span className="tile-value">
        {value}{unit && <small> {unit}</small>}
      </span>
      {note && <span className="tile-note">{note}</span>}
    </>
  );
  return onClick
    ? <button type="button" className="tile tile-btn" aria-pressed={pressed ?? false}
              onClick={onClick}>{inner}</button>
    : <div className="tile">{inner}</div>;
}
