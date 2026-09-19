/**
 * A number, its unit, and what it is being compared to.
 *
 * Deliberately has no colour prop. A tile reports; whether the report is bad
 * news is the job of one Chip elsewhere on the screen (src/lib/severity.ts).
 */
export function StatTile({ label, value, unit, note }: {
  label: string;
  value: string;
  unit?: string;
  note?: React.ReactNode;
}) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {value}{unit && <small> {unit}</small>}
      </div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}
