import { DailyTotal } from '../types';
import { shortDay } from '../lib/time';

const W = 126;
const H = 28;
const GAP = 2;

/**
 * Fourteen days in a table cell: one bar per day, the target as a hairline.
 *
 * Bars are one colour whether or not they cross the line. Position against the
 * target already says "over"; painting those bars red as well would put a dozen
 * status marks on a roster whose whole discipline is one chip per row.
 *
 * An unlogged day is a tick on the baseline, not a missing bar - a gap reads as
 * "zero", and zero is exactly what it is not.
 */
export function Sparkline({ daily, targetMg }: { daily: DailyTotal[]; targetMg: number }) {
  const max = Math.max(targetMg * 1.15, ...daily.map((d) => d.total_sodium_mg));
  const slot = W / daily.length;
  const y = (mg: number) => H - (mg / max) * H;

  const logged = daily.filter((d) => d.logged);
  const over = logged.filter((d) => d.total_sodium_mg > targetMg).length;
  const summary = `${logged.length} of ${daily.length} days logged, ${over} over the `
    + `${targetMg.toLocaleString()} mg target`;

  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`}
         role="img" aria-label={summary}>
      {daily.map((d, i) => {
        const x = i * slot + GAP / 2;
        const w = slot - GAP;
        return d.logged ? (
          <rect key={d.date} x={x} width={w} rx={1.5}
                y={y(d.total_sodium_mg)} height={Math.max(1, H - y(d.total_sodium_mg))}
                fill="var(--series-salinity)">
            <title>{`${shortDay(d.date)} · ${Math.round(d.total_sodium_mg).toLocaleString()} mg`}</title>
          </rect>
        ) : (
          <rect key={d.date} x={x + w / 2 - 1} width={2} y={H - 3} height={3}
                fill="var(--axis)">
            <title>{`${shortDay(d.date)} · nothing logged`}</title>
          </rect>
        );
      })}
      <line x1={0} x2={W} y1={y(targetMg)} y2={y(targetMg)}
            stroke="var(--text-secondary)" strokeWidth={1} strokeDasharray="3 2" />
    </svg>
  );
}
