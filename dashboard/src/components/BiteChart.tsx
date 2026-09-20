import {
  CartesianGrid, ErrorBar, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import { Bite } from '../types';
import { clockTime, shortTime } from '../lib/time';
import { fmtMg, fmtSaltPct, portionNote } from '../lib/sodium';

/**
 * Sodium per bite, with the range each estimate actually carries.
 *
 * The data is discrete - one trustworthy value per scoop - so it is drawn as
 * discrete marks. Drawing it as a continuous line over raw samples produced a
 * chart that was mostly empty air with narrow spikes, spending half the screen
 * on very little. The sample-level signal still matters for tuning, so it lives
 * in its own diagnostics panel rather than taking top billing here.
 *
 * The whiskers are not decoration. Scoop volume is estimated, not weighed, and
 * a bare point estimate would overclaim what this hardware can do. The caption
 * says which estimate, from the bites' own volume_source.
 */

interface Point {
  t: number;
  mg: number;
  err: [number, number];
  g_l: number;
  tempC: number;
  samples: number;
  biteId: number;
}

function BiteTip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p: Point = payload[0].payload;
  return (
    <div className="tip">
      <div className="tip-t">{clockTime(p.t)} · bite #{p.biteId}</div>
      <div className="tip-row">
        <span className="swatch" style={{ background: 'var(--series-salinity)' }} />
        {fmtMg(p.mg)} mg sodium
      </div>
      <div className="tip-note">
        range {fmtMg(p.mg - p.err[0])}–{fmtMg(p.mg + p.err[1])} mg ·{' '}
        {fmtSaltPct(p.g_l)} salt · {p.tempC.toFixed(0)} °C · {p.samples} samples
      </div>
    </div>
  );
}

export function BiteChart({ bites }: { bites: Bite[] }) {
  // Oldest first, so time runs left to right.
  const data: Point[] = bites
    .slice()
    .reverse()
    .map((b) => ({
      t: new Date(b.timestamp).getTime(),
      mg: b.sodiumEstimate,
      err: [
        Math.max(0, b.sodiumEstimate - b.sodium_mg_low),
        Math.max(0, b.sodium_mg_high - b.sodiumEstimate),
      ],
      g_l: b.salinity_g_l,
      tempC: b.tempC,
      samples: b.ec_sample_count,
      biteId: b.bite_id,
    }));

  // One bite has no span to scale: centre it in a minute and tick it, or the
  // axis invents a domain and prints the same second five times.
  const first = data[0]?.t ?? 0;
  const last = data[data.length - 1]?.t ?? 0;
  const lone = data.length === 1;
  // Past two minutes the seconds are noise, and they crowd the ticks out. Then
  // the ticks sit on whole minutes - left to itself the axis prints "4:12 PM"
  // under two different instants.
  const minutes = last - first > 120_000;
  const stepMs = Math.ceil((last - first) / 60_000 / 6) * 60_000;
  const minuteTicks: number[] = [];
  if (minutes) {
    for (let t = Math.ceil(first / stepMs) * stepMs; t <= last; t += stepMs) minuteTicks.push(t);
  }
  const tickTime = minutes
    ? (t: number) => shortTime(new Date(t).toISOString())
    : (t: number) => clockTime(t);

  return (
    <section className="card">
      <h2>Sodium per bite</h2>
      <p className="cap">
        Each mark is one scoop · whiskers are the range: {portionNote(bites[0]?.volume_source)}
      </p>

      {data.length === 0 ? (
        <p className="empty">No bites yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={216}>
          {/* The end ticks sit on the plot's edges and are centred there, so the
              right margin is half a "4:24:12 PM" label, or it is cut off. */}
          <ScatterChart margin={{ top: 10, right: 44, bottom: 0, left: -10 }}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis
              type="number" dataKey="t"
              domain={lone ? [first - 30_000, first + 30_000] : ['dataMin', 'dataMax']}
              ticks={lone ? [first] : minutes ? minuteTicks : undefined}
              tickFormatter={tickTime}
              stroke="var(--axis)" tickLine={false}
              tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--mono)' }}
              minTickGap={58}
            />
            <YAxis
              type="number" dataKey="mg"
              stroke="var(--axis)" tickLine={false} axisLine={false} width={60}
              tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--mono)' }}
              tickFormatter={(v) => `${v} mg`}
              domain={[0, (max: number) => Math.ceil((max * 1.25) / 5) * 5]}
            />
            <ZAxis range={[46, 46]} />
            <Tooltip content={<BiteTip />} cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} />
            <Scatter
              data={data}
              fill="var(--series-salinity)"
              isAnimationActive={false}
              line={{ stroke: 'var(--series-salinity)', strokeWidth: 1, strokeOpacity: 0.3 }}
            >
              <ErrorBar
                dataKey="err" direction="y" width={5}
                strokeWidth={1.5} stroke="var(--series-salinity)" strokeOpacity={0.55}
              />
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}
