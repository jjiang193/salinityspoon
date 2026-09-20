import {
  Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { DailyTotal, SummaryRange } from '../types';
import { fmtMg } from '../lib/sodium';
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
 *
 * The last day is today, and today is unfinished. It is drawn at reduced
 * opacity - the same two series colours, not a third - and labelled "today so
 * far", because a chart that always ends in a low bar reads as improvement
 * every morning. The averages exclude today for the same reason.
 *
 * A logged day carries its range in the tooltip like every other sodium figure:
 * the linear sum of its per-bite ranges, which overstates the spread on purpose
 * (docs/telemetry-schema.md), with self-reported food counted as entered.
 */

/** Today's bar: present, but visibly not a finished day. A theme token
 *  (styles.css): 0.45 on the white surface, 0.6 on the dark one, where 0.45 of a
 *  series colour sinks into the grid. It goes in `style`, not an attribute. */
export const TODAY_OPACITY = 'var(--today-opacity)';

// The day axis, shared with VitalsTimeline: same margins, same y-axis width and
// the same tick rule put the same day at the same x in every chart of the stack.
export const DAY_CHART_MARGIN = { top: 12, right: 8, bottom: 0, left: -6 };
export const DAY_AXIS_WIDTH = 50;
// A month ticks weekly: every label the same weekday, and room for them at 390px.
export const dayTickInterval = (days: number) => (days > 14 ? 6 : days > 7 ? 1 : 0);
/** The day tooltips are pinned to the top of their plot and lifted by their own
 *  height (.tip-up), so they stand over the legend and caption rather than over
 *  the neighbouring days - which are what the hovered day is compared with. */
export const DAY_TIP_WRAPPER = { zIndex: 5 };

function DayTip({ active, payload, targetMg, todayDate, noun }: any) {
  if (!active || !payload?.length) return null;
  const d: DailyTotal = payload[0].payload;
  return (
    <div className="tip tip-up">
      <div className="tip-t">
        {weekday(d.date)} · {shortDay(d.date)}{d.date === todayDate && ' · today so far'}
      </div>
      {d.logged ? (
        <>
          <div className="tip-row">
            <span className="swatch" style={{ background: 'var(--series-salinity)' }} />
            {fmtMg(d.measured_sodium_mg)} mg measured · {d.bite_count} bite{d.bite_count === 1 ? '' : 's'}
          </div>
          <div className="tip-row">
            <span className="swatch" style={{ background: 'var(--series-manual)' }} />
            {fmtMg(d.manual_sodium_mg)} mg self-reported
          </div>
          <div className="tip-note">
            {fmtMg(d.total_sodium_mg)} mg total ·{' '}
            {((d.total_sodium_mg / targetMg) * 100).toFixed(0)}% of {noun}
          </div>
          <div className="tip-note tip-wrap">
            {d.bite_count > 0
              ? <>range {fmtMg(d.total_sodium_mg_low)}–{fmtMg(d.total_sodium_mg_high)} mg · sum of
                  per-bite ranges; self-reported counted as entered</>
              // Nothing was measured, so there is no spread to state: 120–120 is not a range.
              : 'self-reported only · counted as entered, so it carries no range'}
          </div>
        </>
      ) : (
        <div className="tip-note">Nothing logged. Not counted in any average.</div>
      )}
    </div>
  );
}

export function DailyTrendChart({ daily, targetMg, caption, noun = 'target', range, onRange, syncId }: {
  daily: DailyTotal[];
  targetMg: number;
  caption?: string;
  /** What the dashed line is called. The clinician set a target; to the patient
   *  it bounds the day, so the portal calls it a limit. */
  noun?: 'target' | 'limit';
  /** NaTrack's summary range. `day` is a single bar, so only these two are offered. */
  range: SummaryRange;
  onRange: (range: SummaryRange) => void;
  /** Shared with VitalsTimeline, so one hover reads a day across both cards. */
  syncId?: string;
}) {
  // cohort.summarise puts today last.
  const todayDate = daily[daily.length - 1]?.date;
  const anyLogged = daily.some((d) => d.logged);
  const todayLogged = daily[daily.length - 1]?.logged ?? false;
  // Round ticks, chosen here: left alone the axis lands on 650 and 1,300.
  const peak = Math.max(targetMg * 1.1, ...daily.map((d) => d.total_sodium_mg));
  const step = peak > 3000 ? 1000 : 500;
  const ticks = Array.from({ length: Math.ceil(peak / step) + 1 }, (_, i) => i * step);

  const top: [number, number, number, number] = [4, 4, 0, 0];
  const flat: [number, number, number, number] = [0, 0, 0, 0];

  return (
    <section className="card">
      <div className="card-head">
        {/* A week is the seven finished days the averages cover, and today. */}
        <h2>
          Daily sodium · {range === 'week' && daily.length > 1
            ? `last ${daily.length - 1} full days + today`
            : `last ${daily.length} days`}
        </h2>
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
            {/* A key for a bar that is not there is noise. */}
            {todayLogged && (
              <span>
                {/* Both series, faded: today's bar can be either, or both. */}
                <i className="today-key" />
                Today so far · not in the averages
              </span>
            )}
            <span><i className="dash" />{noun === 'limit' ? 'Limit' : 'Target'} {fmtMg(targetMg)} mg</span>
          </div>
          <ResponsiveContainer width="100%" height={232}>
            <BarChart data={daily} margin={DAY_CHART_MARGIN} syncId={syncId}
                      barCategoryGap="22%">
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis
                dataKey="date" tickFormatter={shortDay}
                interval={dayTickInterval(daily.length)}
                stroke="var(--axis)" tickLine={false}
                tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--mono)' }}
              />
              <YAxis
                stroke="var(--axis)" tickLine={false} axisLine={false} width={DAY_AXIS_WIDTH}
                tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--mono)' }}
                tickFormatter={(v: number) => v.toLocaleString()}
                ticks={ticks} domain={[0, ticks[ticks.length - 1]]}
              />
              <Tooltip content={<DayTip targetMg={targetMg} todayDate={todayDate} noun={noun} />}
                       isAnimationActive={false} position={{ y: DAY_CHART_MARGIN.top }}
                       allowEscapeViewBox={{ x: false, y: true }} wrapperStyle={DAY_TIP_WRAPPER}
                       cursor={{ fill: 'var(--grid)', opacity: 0.5 }} />
              <Bar dataKey="measured_sodium_mg" stackId="day" fill="var(--series-salinity)"
                   stroke="var(--surface)" strokeWidth={1} isAnimationActive={false}>
                {daily.map((d) => (
                  // The rounded end belongs to whichever segment is on top.
                  <Cell key={d.date} radius={(d.manual_sodium_mg > 0 ? flat : top) as any}
                        style={d.date === todayDate ? { fillOpacity: TODAY_OPACITY } : undefined} />
                ))}
              </Bar>
              <Bar dataKey="manual_sodium_mg" stackId="day" fill="var(--series-manual)"
                   stroke="var(--surface)" strokeWidth={1} radius={top}
                   isAnimationActive={false}>
                {daily.map((d) => (
                  <Cell key={d.date}
                        style={d.date === todayDate ? { fillOpacity: TODAY_OPACITY } : undefined} />
                ))}
              </Bar>
              <ReferenceLine y={targetMg} stroke="var(--text-secondary)"
                             strokeDasharray="4 3" strokeWidth={1.5} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </section>
  );
}
