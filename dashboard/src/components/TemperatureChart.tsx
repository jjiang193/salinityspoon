import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChartPoint, PROBE_TEMP_MAX_C } from '../types';
import { clockTime, relativeTick } from '../lib/time';

function TempTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p: ChartPoint = payload[0].payload;
  if (p.temp_c === null) return null;
  return (
    <div className="tip">
      <div className="tip-t">{clockTime(label)}</div>
      <div className="tip-row">
        <span className="swatch" style={{ background: 'var(--series-temp)' }} />
        {p.temp_c.toFixed(1)} °C
      </div>
      <div className="tip-note">
        {p.temp_in_range ? 'within the probe’s range' : 'out of range · no bite can be logged'}
      </div>
    </div>
  );
}

/**
 * Its own chart on its own axis, deliberately — a different measure in
 * different units, and overlaying it on salinity would invent a correlation.
 *
 * The 40 °C line is the most consequential thing on this dashboard: above it
 * the probe is out of spec and no bite is recorded at all.
 */
export function TemperatureChart({ points }: { points: ChartPoint[] }) {
  const withTemp = points.filter((p) => p.temp_c !== null);
  const now = withTemp.length ? withTemp[withTemp.length - 1].t : Date.now();

  return (
    <section className="card">
      <h2>Liquid temperature</h2>
      <p className="caption">
        Drives EC compensation · above {PROBE_TEMP_MAX_C} °C the probe is out of
        spec and bites are refused
      </p>

      {withTemp.length < 2 ? (
        <p className="empty">Waiting for the DS18B20…</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={withTemp} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="t" type="number" domain={['dataMin', 'dataMax']}
              tickFormatter={(t: number) => relativeTick(t, now)}
              stroke="var(--axis)" tickLine={false}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }} minTickGap={48}
            />
            <YAxis
              stroke="var(--axis)" tickLine={false} axisLine={false} width={48}
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickFormatter={(v) => `${v}°`}
              domain={[
                (min: number) => Math.floor(Math.min(min, 15)),
                (max: number) => Math.ceil(Math.max(max, PROBE_TEMP_MAX_C + 5)),
              ]}
            />
            <Tooltip content={<TempTip />} cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} />

            <ReferenceLine
              y={PROBE_TEMP_MAX_C}
              stroke="var(--limit-line)" strokeWidth={2} strokeDasharray="4 3"
              label={{ value: `probe limit ${PROBE_TEMP_MAX_C} °C`, position: 'insideTopRight',
                       fill: 'var(--limit-line)', fontSize: 10 }}
            />
            <Line
              type="monotone" dataKey="temp_c" dot={false} isAnimationActive={false}
              stroke="var(--series-temp)" strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}
