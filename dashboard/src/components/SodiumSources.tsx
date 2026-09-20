import { SodiumSourceItem, SodiumSources as Sources } from '../types';
import { REFERENCE_SERVING_ML, fmtMg, fmtSaltPct } from '../lib/sodium';
import * as sev from '../lib/severity';
import { Chip } from './Chip';

const VISIBLE = 8;

const KIND_COLOUR: Record<SodiumSourceItem['kind'], string> = {
  measured: 'var(--series-salinity)',
  manual: 'var(--series-manual)',
};

const pctOf = (part: number, whole: number) => `${((part / whole) * 100).toFixed(0)}%`;

/**
 * Where the logged sodium came from: one row per product the spoon measured and
 * one per self-reported food, largest first.
 *
 * This is a sort, not a score. It is arithmetic over rows already stored - a
 * sum per product and the weight-averaged salinity of its bowls - and no row is
 * marked good or bad. What it gives a counselling conversation is something
 * specific to point at: not "your week was high" but "the broth, nine times".
 *
 * Measured and self-reported rows never merge and never share a colour, the
 * same rule the trend chart keeps: one was read by a probe and carries a range,
 * the other is what the patient typed. The two series colours appear only as
 * swatches and bars, to say which kind a row is. The one status colour in the
 * card is the label flag, the same chip the meals table gives a flagged meal
 * (src/lib/severity.ts) - a product sold as low sodium that measures like
 * ordinary broth is the row a clinician most needs to see here.
 *
 * Shares are of LOGGED sodium. The caption says so, because a share reads as
 * "of the diet" unless told otherwise.
 */
export function SodiumSources({ sources, variant = 'clinician' }: {
  sources: Sources;
  variant?: 'clinician' | 'patient';
}) {
  const patient = variant === 'patient';
  const total = sources.total_sodium_mg;
  const shown = sources.items.slice(0, VISIBLE);
  const rest = sources.items.slice(VISIBLE);
  // Bars are scaled to the largest share, not to 100%: with a dozen sources the
  // biggest is often under a third, and bars drawn against 100 would all be stubs.
  const maxShare = Math.max(...sources.items.map((i) => i.share_pct), 0);

  return (
    <section className="card">
      <h2>{patient ? 'Where your sodium comes from' : 'Where the sodium comes from'}</h2>
      <p className="cap sources-head">
        <span>
          Last {sources.days} day{sources.days === 1 ? '' : 's'}
          {sources.days_logged > 0 && `, ${sources.days_logged} logged`}
        </span>
        {total > 0 && (
          <>
            <span><i style={{ background: KIND_COLOUR.measured }} />
              {pctOf(sources.measured_sodium_mg, total)} measured by the spoon</span>
            <span><i style={{ background: KIND_COLOUR.manual }} />
              {pctOf(sources.manual_sodium_mg, total)} self-reported</span>
          </>
        )}
      </p>

      {sources.items.length === 0 ? (
        <p className="empty">Nothing logged in this period.</p>
      ) : (
        <div className="scroller"><table className="sources">
          <thead>
            <tr>
              <th>Source</th>
              <th className="num hide-narrow">Times</th>
              <th className="num">Sodium</th>
              <th className="share-col">Share</th>
              <th className="num hide-narrow"
                  title="Mean over these bowls, NaCl-equivalent salinity">Typical bowl</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr key={`${item.kind}:${item.name ?? ''}:${item.label_claim ?? ''}`}>
                <td>
                  <div className="source-name">
                    <i className="swatch" style={{ background: KIND_COLOUR[item.kind] }} />
                    {item.name === null
                      ? <span className="muted">Not declared</span>
                      : <span className="primary">{item.name}</span>}
                  </div>
                  <div className="sub-line source-sub">{subLine(item)}</div>
                  {item.flagged_count > 0 && (
                    <div className="source-flag">
                      <Chip indicator={sev.labelFlagCount(item.flagged_count, item.count)} />
                    </div>
                  )}
                </td>
                <td className="num hide-narrow">{item.count}</td>
                <td className="num primary nowrap">{fmtMg(item.sodium_mg)} mg</td>
                <td className="share-col">
                  <ShareBar pct={item.share_pct} max={maxShare} colour={KIND_COLOUR[item.kind]} />
                </td>
                <td className="num hide-narrow nowrap">
                  {item.kind === 'measured' && item.mean_salinity_g_l !== null ? (
                    <>
                      <span className="primary">{fmtSaltPct(item.mean_salinity_g_l)}</span>
                      {item.mg_per_serving !== null && (
                        <div className="sub-line">
                          {fmtMg(item.mg_per_serving)} mg / {REFERENCE_SERVING_ML} mL
                        </div>
                      )}
                    </>
                  ) : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
            {rest.length > 0 && (
              <tr className="sources-other">
                <td className="muted">Other ({rest.length} more)</td>
                <td className="num hide-narrow muted">
                  {rest.reduce((n, i) => n + i.count, 0)}
                </td>
                <td className="num nowrap">{fmtMg(rest.reduce((n, i) => n + i.sodium_mg, 0))} mg</td>
                <td className="share-col">
                  {/* Both kinds can be in here, so this bar takes neither colour. */}
                  <ShareBar pct={rest.reduce((n, i) => n + i.share_pct, 0)} max={maxShare}
                            colour="var(--axis)" />
                </td>
                <td className="num hide-narrow"><span className="muted">—</span></td>
              </tr>
            )}
          </tbody>
        </table></div>
      )}

      {/* The caveat qualifies the shares; with nothing logged there are none. */}
      {sources.items.length > 0 && <p className="note">
        {patient
          ? 'Shares are of logged sodium only: liquids the spoon measured plus what you entered. '
            + 'A lower bound, not your whole diet. '
          : 'Shares are of logged sodium only: liquids the spoon measured plus what the patient '
            + 'entered. A lower bound, not the whole diet. '}
        Concentrations are NaCl-equivalent salinity.
      </p>}
    </section>
  );
}

function subLine(item: SodiumSourceItem): string {
  if (item.kind === 'manual') return `self-reported${item.portion ? ` · usually ${item.portion}` : ''}`;
  if (item.name === null) return 'meals started without saying what was in the bowl';
  if (item.label_claim_label && item.label_claim !== 'none')
    return `measured · labelled ${item.label_claim_label.toLowerCase()}`;
  return 'measured by the spoon';
}

/** The share as a number, and as a length against the largest share in the list. */
function ShareBar({ pct, max, colour }: { pct: number; max: number; colour: string }) {
  // The number is the value; the bar only makes the ranking readable at a
  // glance, so it is hidden from a screen reader rather than read out twice.
  const width = max > 0 ? Math.min(100, (pct / max) * 100) : 0;
  return (
    <div className="share">
      <span className="share-pct">{pct.toFixed(0)}%</span>
      <div className="share-track" aria-hidden="true">
        <div className="share-fill" style={{ width: `${width}%`, background: colour }} />
      </div>
    </div>
  );
}
