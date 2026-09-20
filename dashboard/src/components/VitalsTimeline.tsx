import {
  Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { DailyTotal, HealthLog } from '../types';
import { localDayKey, shortDay, shortTime, weekday } from '../lib/time';
import {
  DAY_AXIS_WIDTH, DAY_CHART_MARGIN, DAY_TIP_WRAPPER, dayTickInterval,
} from './DailyTrendChart';
import { HealthLogTable } from './HealthLogCard';

/**
 * Blood pressure and weight on the same days as the sodium chart above it.
 *
 * This is the conversation NaTrack's HealthLog exists for - what went in, and
 * what the body did - and a clinician should not have to line up a table with a
 * chart by eye to have it. So: one row per day of `daily`, in the same order,
 * with the same margins, y-axis width and tick rule as DailyTrendChart, and a
 * shared syncId. The same day sits at the same x in all three plots and one
 * hover reads down through them.
 *
 * Two small multiples, each with its own y-axis. Never a second axis on the
 * sodium chart: two scales on one plot invite the reader to see the lines cross
 * and call it a finding.
 *
 * HealthLogCard's rule carries over whole. Nothing here interprets a reading:
 * no thresholds, no bands, no trend arrows, no correlation figure, no colour.
 * One neutral ink. A day without a reading is a gap, and the weight line breaks
 * across it - an unlogged day is not a value, here as everywhere else.
 *
 * Several readings in a day: the mark is the latest, the tooltip lists them all.
 * "Readings as entered", closed under the panels, is the same period as a table:
 * the accessible view of the plots, and where a note is read. It used to be a
 * card of its own beside this one, repeating the numbers and the empty state.
 */

interface Row {
  date: string;
  systolic: number | null;
  diastolic: number | null;
  weightKg: number | null;
  /** Every entry made that day, earliest first. */
  entries: HealthLog[];
}

const INK = 'var(--text-secondary)';
const PANEL_H = 96;
/** The lower panel also carries the day labels. */
const AXIS_H = 24;
/** Under the upper panel: room for the lowest y tick label, which Recharts
 *  drops if it would overhang the plot. */
const BARE_AXIS_H = 8;
const TICK = { fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--mono)' };

function buildRows(daily: DailyTotal[], entries: HealthLog[]): Row[] {
  const byDay = new Map<string, HealthLog[]>();
  for (const e of entries) {
    const key = localDayKey(e.timestamp);
    byDay.set(key, [...(byDay.get(key) ?? []), e]);
  }
  return daily.map((d) => {
    const day = (byDay.get(d.date) ?? [])
      .slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const bp = day.filter((e) => e.systolic !== null).pop();
    const wt = day.filter((e) => e.weightKg !== null).pop();
    return {
      date: d.date,
      systolic: bp?.systolic ?? null,
      diastolic: bp?.diastolic ?? null,
      weightKg: wt?.weightKg ?? null,
      entries: day,
    };
  });
}

/** At most five round ticks from `lo`, the last at or past `hi` - the ticks are
 *  the domain, so stopping short of `hi` would clip the data. */
function roundTicks(lo: number, hi: number, unit: number): number[] {
  let step = unit;
  while ((hi - lo) / step > 4) step += unit;
  const ticks = [lo];
  while (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** The day's readings, exactly as entered. One box for both panels: the hover
 *  is synced, and a second box repeating the date beside the sodium tooltip
 *  would be noise. For the same reason a day without a reading says nothing. */
function VitalsTip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const row: Row = payload[0].payload;
  const shown = row.entries.filter((e) => e.systolic !== null || e.weightKg !== null);
  if (shown.length === 0) return null;
  return (
    <div className="tip tip-up">
      <div className="tip-t">{weekday(row.date)} · {shortDay(row.date)}</div>
      {shown.map((e) => (
        <div key={e.id}>
          <div className="tip-row">
            {[
              e.systolic !== null && `${e.systolic}/${e.diastolic} mmHg`,
              e.weightKg !== null && `${e.weightKg.toFixed(1)} kg`,
            ].filter(Boolean).join(' · ')}
            <span className="muted">· {shortTime(e.timestamp)}</span>
          </div>
          {e.note && <div className="tip-note tip-wrap">{e.note}</div>}
        </div>
      ))}
    </div>
  );
}

export function VitalsTimeline({ daily, entries, error, syncId, limit }: {
  daily: DailyTotal[];
  /** Null while loading. Fetched once by the view. */
  entries: HealthLog[] | null;
  error: boolean;
  syncId?: string;
  /** The row cap the entries were fetched under. At the cap the answer may stop
   *  short of the period, and a day before it is not loaded, not unlogged. */
  limit?: number;
}) {
  const rows = entries ? buildRows(daily, entries) : [];
  const inPeriod = rows.flatMap((r) => r.entries);
  // Newest first, as the log is read.
  const listed = inPeriod.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const oldest = entries && limit !== undefined && entries.length >= limit
    ? entries.reduce((min, e) => (e.timestamp < min ? e.timestamp : min), entries[0].timestamp)
    : null;
  const cutOff = oldest !== null && daily.length > 0 && localDayKey(oldest) > daily[0].date
    ? localDayKey(oldest) : null;
  const bpCount = inPeriod.filter((e) => e.systolic !== null).length;
  const weightCount = inPeriod.filter((e) => e.weightKg !== null).length;
  const hasBp = bpCount > 0;
  const hasWeight = weightCount > 0;

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const summary = `${bpCount} blood pressure and ${plural(weightCount, 'weight reading')} `
    + `in the last ${plural(daily.length, 'day')}`;

  // Each panel's own scale, padded out to round numbers around its own data.
  const marks = rows.filter((r) => r.systolic !== null);
  const bpLo = Math.floor(Math.min(...marks.map((r) => r.diastolic!)) / 10) * 10;
  const bpHi = Math.ceil(Math.max(...marks.map((r) => r.systolic!)) / 10) * 10;
  const weights = rows.filter((r) => r.weightKg !== null).map((r) => r.weightKg!);
  // Weight to the half-kilogram around the data, no more. A kilogram of padding
  // each side, then whole-kilogram steps, gave 1.8 kg of change 6 kg of axis -
  // the rise the panel exists to show read as flat. That is scale, not reading.
  let kgLo = Math.floor(Math.min(...weights) * 2) / 2;
  let kgHi = Math.ceil(Math.max(...weights) * 2) / 2;
  if (kgLo === kgHi) { kgLo -= 0.5; kgHi += 0.5; }

  const xAxis = (labelled: boolean) => (
    <XAxis
      dataKey="date" tickFormatter={shortDay} interval={dayTickInterval(daily.length)}
      stroke="var(--axis)" tickLine={false}
      tick={labelled ? TICK : false} height={labelled ? AXIS_H : BARE_AXIS_H}
    />
  );
  const yAxis = (ticks: number[], format?: (v: number) => string) => (
    <YAxis
      stroke="var(--axis)" tickLine={false} axisLine={false} width={DAY_AXIS_WIDTH}
      tick={TICK} ticks={ticks} interval={0} domain={[ticks[0], ticks[ticks.length - 1]]}
      tickFormatter={format}
    />
  );
  // The upper panel speaks for both; the other still draws its cursor, so the
  // hovered day is marked in every plot. Pinned: a synced tooltip otherwise
  // takes its y from a pointer that is in another chart. It stands on top of the
  // panel and grows upwards, so it never covers the neighbouring days' marks.
  const tooltip = (speaks: boolean) => (
    <Tooltip content={speaks ? <VitalsTip /> : () => null} isAnimationActive={false}
             position={{ y: 0 }} allowEscapeViewBox={{ x: false, y: true }}
             wrapperStyle={DAY_TIP_WRAPPER} cursor={{ fill: 'var(--grid)', opacity: 0.5 }} />
  );

  return (
    <section className="card">
      <h2>Blood pressure and weight</h2>
      <p className="cap">
        Logged by the patient, recorded as entered, not interpreted. Shown beside sodium for
        the conversation, not as cause and effect.
      </p>

      {error && !entries ? (
        // A log that could not be read is not an empty log.
        <p className="empty" role="status">Can't load the health log right now.</p>
      ) : !entries ? (
        <p className="empty">Loading readings…</p>
      ) : !hasBp && !hasWeight ? (
        <p className="empty">No readings logged in this period.</p>
      ) : (
        <div role="img" aria-label={summary}>
          {hasBp && (
            <>
              <div className="panel-label">Blood pressure · mmHg</div>
              <ResponsiveContainer width="100%" height={PANEL_H + (hasWeight ? 0 : AXIS_H)}>
                <BarChart data={rows} margin={DAY_CHART_MARGIN} syncId={syncId}
                          barCategoryGap="22%">
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  {xAxis(!hasWeight)}
                  {yAxis(roundTicks(bpLo, bpHi, 10))}
                  {tooltip(true)}
                  {/* A floating bar: diastolic at the foot, systolic at the head. */}
                  <Bar dataKey={(r: Row) => (r.systolic === null ? null : [r.diastolic, r.systolic])}
                       barSize={4} radius={2} fill={INK} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </>
          )}
          {hasWeight && (
            <>
              <div className="panel-label">Weight · kg</div>
              <ResponsiveContainer width="100%" height={PANEL_H + AXIS_H}>
                {/* ComposedChart with a Bar that draws nothing: Recharts lays days out
                    in bands - ticks, cursor and points at band centres - only when a
                    chart holds a Bar. That is what puts a day's dot over its sodium bar. */}
                <ComposedChart data={rows} margin={DAY_CHART_MARGIN} syncId={syncId}>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  {xAxis(true)}
                  {yAxis(roundTicks(kgLo, kgHi, 0.5), (v) => v.toFixed(1))}
                  {tooltip(!hasBp)}
                  <Bar dataKey={() => null} isAnimationActive={false} />
                  {/* connectNulls off: a gap in the log stays a gap in the line. */}
                  <Line dataKey="weightKg" connectNulls={false} stroke={INK} strokeWidth={1.5}
                        dot={{ r: 2.5, fill: INK, stroke: 'var(--surface)', strokeWidth: 1 }}
                        activeDot={{ r: 4, fill: INK, stroke: 'var(--surface)', strokeWidth: 2 }}
                        isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      )}
      {cutOff !== null && (
        <p className="note fine" role="status">
          Showing the latest {limit} readings. Days before {shortDay(cutOff)} were not
          loaded, which is not the same as nothing logged.
        </p>
      )}
      {listed.length > 0 && (
        <details className="earlier">
          <summary>Readings as entered ({listed.length})</summary>
          <HealthLogTable entries={listed} style={{ marginTop: 10 }} />
        </details>
      )}
    </section>
  );
}
