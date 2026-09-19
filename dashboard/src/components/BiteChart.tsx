import {
  CartesianGrid, ErrorBar, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import { Bite } from '../types';
import { clockTime } from '../lib/time';

/**
 * Sodium per bite, with the range each estimate actually carries.
 *
 * The data is discrete - one trustworthy value per scoop - so it is drawn as
 * discrete marks. Drawing it as a continuous line over raw samples produced a
 * chart that was mostly empty air with narrow spikes, spending half the screen
 * on very little. The sample-level signal still matters for tuning, so it lives
 * in its own diagnostics panel rather than taking top billing here.
 *
 * The whiskers are not decoration. Scoop volume is calibrated, not weighed, and
 * a bare point estimate would overclaim what this hardware can do.
 */

interface Point {
  t: number;
  mg: number;
  err: [number, number];
  saltPct: number;
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
        {p.mg.toFixed(1)} mg sodium
      </div>
      <div className="tip-note">
        range {(p.mg - p.err[0]).toFixed(0)}–{(p.mg + p.err[1]).toFixed(0)} mg ·{' '}
        {p.saltPct.toFixed(2)}% salt · {p.tempC.toFixed(0)} °C · {p.samples} samples
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
      saltPct: b.salinity_g_l / 10,
      tempC: b.tempC,
      samples: b.ec_sample_count,
      biteId: b.bite_id,
    }));

  return (
    <section className="card">
      <h2>Sodium per bite</h2>
      <p className="cap">
        Each mark is one scoop · whiskers are the range from calibrated scoop volume
      </p>

      {data.length === 0 ? (
        <p className="empty">No bites yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={216}>
          <ScatterChart margin={{ top: 10, right: 12, bottom: 0, left: -10 }}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis
              type="number" dataKey="t"
              domain={data.length > 1 ? ['dataMin', 'dataMax'] : ['auto', 'auto']}
              tickFormatter={(t: number) =>
                new Date(t).toLocaleTimeString([], {
                  hour: 'numeric', minute: '2-digit', second: '2-digit',
                })}
              stroke="var(--axis)" tickLine={false}
              tick={{ fill: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--mono)' }}
              minTickGap={58}
            />
            <YAxis
              type="number" dataKey="mg"
              stroke="var(--axis)" tickLine={false} axisLine={false} width={46}
              tick={{ fill: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--mono)' }}
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
