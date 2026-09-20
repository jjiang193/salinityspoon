import { Bite } from '../types';
import { fmtMg, fmtSaltPct } from '../lib/sodium';
import { shortTime } from '../lib/time';
import * as sev from '../lib/severity';
import { Chip } from './Chip';

/**
 * Per-bite detail. Also the accessibility fallback for the charts above:
 * every measurement is readable as text, not only as colour and position.
 */
/** Rows shown. The card is "recent bites", not every bite - the chart above
 *  carries the full meal. */
const VISIBLE = 8;

export function BiteTable({ bites }: { bites: Bite[] }) {
  const shown = bites.slice(0, VISIBLE);
  return (
    <section className="card">
      <h2>Recent bites</h2>
      <p className="cap">
        Each row is one scoop, scored on the median of its captured EC samples
        {bites.length > VISIBLE && ` · showing the latest ${VISIBLE} of ${bites.length}`}
      </p>

      {bites.length === 0 ? (
        <p className="empty">No bites yet.</p>
      ) : (
        <div className="scroller"><table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Pace</th>
              <th className="num">Salt</th>
              <th className="num">Temp</th>
              <th className="num">Weight</th>
              <th className="num">Sodium</th>
              <th className="num">Range</th>
              <th className="num">Samples</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => {
              return (
                <tr key={`${b.deviceId}-${b.bite_id}-${b.timestamp}`}>
                  <td className="primary">{shortTime(b.timestamp)}</td>
                  {/* A meal's first bite has no pace: a dash, not a chip around one. */}
                  <td>
                    {sev.pace(b.pace).label === '—'
                      ? <span className="muted">—</span>
                      : <Chip indicator={sev.pace(b.pace)} />}
                  </td>
                  <td className="num">{fmtSaltPct(b.salinity_g_l)}</td>
                  <td className="num">{b.tempC.toFixed(0)}°C</td>
                  <td className="num">{b.weightGrams.toFixed(1)} g</td>
                  <td className="num primary">{fmtMg(b.sodiumEstimate)} mg</td>
                  <td className="num">
                    {fmtMg(b.sodium_mg_low)}–{fmtMg(b.sodium_mg_high)}
                  </td>
                  <td className="num">{b.ec_sample_count}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
