import {
  Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { DailyTotal, SummaryRange } from '../types';
import { shortDay, weekday } from '../lib/time';

/**
 * Daily sodium against the patient's target, two weeks at a time.
 *
 * Stacked, because the two parts are different kinds of claim: what the spoon
 * measured, and what the patient typed in. They sum to the day's total but they
 * never share a colour (PLAN.md §7: label measured vs self-reported everywhere).
 *
 * A day with nothing logged draws no bar and says so in the tooltip. It is not
 * averaged in anywhere, and it must not look like a good day.
 */

function DayTip({ active, payload, targetMg }: any) {
  if (!active || !payload?.length) return null;
  const d: DailyTotal = payload[0].payload;
  return (
    <div className="tip">
      <div className="tip-t">{weekday(d.date)} · {shortDay(d.date)}</div>
      {d.logged ? (
        <>
          <div className="tip-row">
            <span className="swatch" style={{ background: 'var(--series-salinity)' }} />
            {Math.round(d.measured_sodium_mg).toLocaleString()} mg measured · {d.bite_count} bites
          </div>
          <div className="tip-row">
            <span className="swatch" style={{ background: 'var(--series-manual)' }} />
            {Math.round(d.manual_sodium_mg).toLocaleString()} mg self-reported
          </div>
          <div className="tip-note">
            {Math.round(d.total_sodium_mg).toLocaleString()} mg total ·{' '}
            {((d.total_sodium_mg / targetMg) * 100).toFixed(0)}% of target
          </div>
        </>
      ) : (
        <div className="tip-note">Nothing logged. Not counted in any average.</div>
      )}
    </div>
  );
}

export function DailyTrendChart({ daily, targetMg, caption, range, onRange }: {
  daily: DailyTotal[];
  targetMg: number;
  caption?: string;
  /** NaTrack's summary range. `day` is a single bar, so only these two are offered. */
  range: SummaryRange;
  onRange: (range: SummaryRange) => void;
}) {
  const anyLogged = daily.some((d) => d.logged);
  // Round ticks, chosen here: left alone the axis lands on 650 and 1,300.
  const peak = Math.max(targetMg * 1.1, ...daily.map((d) => d.total_sodium_mg));
  const step = peak > 3000 ? 1000 : 500;
  const ticks = Array.from({ length: Math.ceil(peak / step) + 1 }, (_, i) => i * step);

  const top: [number, number, number, number] = [4, 4, 0, 0];
  const flat: [number, number, number, number] = [0, 0, 0, 0];

  return (
    <section className="card">
      <div className="card-head">
        <h2>Daily sodium · last {daily.length} days</h2>
        <div className="segmented small" role="group" aria-label="Range">
          {(['week', 'month'] as const).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => onRange(r)}>
              {r === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
      </div>
      <p className="cap">
        {caption ?? 'Against the daily target · gaps are days with nothing logged, not zero intake'}
      </p>

      {!anyLogged ? (
        <p className="empty">Nothing logged in this period.</p>
      ) : (
        <>
          <div className="legend">
            <span><i style={{ background: 'var(--series-salinity)' }} />Measured by the spoon</span>
            <span><i style={{ background: 'var(--series-manual)' }} />Self-reported</span>
            <span><i className="dash" />Target {targetMg.toLocaleString()} mg</span>
          </div>
          <ResponsiveContainer width="100%" height={232}>
            <BarChart data={daily} margin={{ top: 12, right: 8, bottom: 0, left: -6 }}
                      barCategoryGap="22%">
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis
                dataKey="date" tickFormatter={shortDay}
                interval={daily.length > 14 ? 4 : daily.length > 7 ? 1 : 0}
                stroke="var(--axis)" tickLine={false}
                tick={{ fill: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--mono)' }}
              />
              <YAxis
                stroke="var(--axis)" tickLine={false} axisLine={false} width={50}
                tick={{ fill: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--mono)' }}
                tickFormatter={(v: number) => v.toLocaleString()}
                ticks={ticks} domain={[0, ticks[ticks.length - 1]]}
              />
              <Tooltip content={<DayTip targetMg={targetMg} />}
                       cursor={{ fill: 'var(--grid)', opacity: 0.5 }} />
              <Bar dataKey="measured_sodium_mg" stackId="day" fill="var(--series-salinity)"
                   stroke="var(--surface)" strokeWidth={1} isAnimationActive={false}>
                {daily.map((d) => (
                  // The rounded end belongs to whichever segment is on top.
                  <Cell key={d.date} radius={(d.manual_sodium_mg > 0 ? flat : top) as any} />
                ))}
              </Bar>
              <Bar dataKey="manual_sodium_mg" stackId="day" fill="var(--series-manual)"
                   stroke="var(--surface)" strokeWidth={1} radius={top}
                   isAnimationActive={false} />
              <ReferenceLine y={targetMg} stroke="var(--text-secondary)"
                             strokeDasharray="4 3" strokeWidth={1.5} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </section>
  );
}
