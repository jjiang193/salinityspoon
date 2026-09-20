import { LabelCheck } from '../types';
import { fmtMg, REFERENCE_SERVING_ML } from '../lib/sodium';
import * as sev from '../lib/severity';
import { Chip, Fact } from './Chip';

interface Props {
  check: LabelCheck | null;
}

/**
 * The one thing this hardware can do that no food database can.
 *
 * Conductivity cannot separate sodium from potassium — normally a limitation.
 * But salt substitutes are potassium chloride, so a product LABELLED
 * low-sodium that MEASURES high ionic content is probably substituting. That
 * matters for kidney patients and anyone on ACE inhibitors, ARBs or
 * potassium-sparing diuretics.
 *
 * A flag, never a diagnosis. The copy says so, deliberately.
 *
 * Display only. What is in the bowl is declared in one place, the patient
 * portal's SessionCard; this card reports how the measurement sits against it.
 */
export function LabelCheckCard({ check }: Props) {
  return (
    <section className="card">
      <h2>Label check</h2>
      <p className="cap">
        {check?.product_name
          ? <>Checking <strong style={{ color: 'var(--text-primary)' }}>{check.product_name}</strong> against its label</>
          : 'What is in the bowl is declared from the patient portal'}
      </p>

      {check && check.claim !== 'none' ? (
        <div>
          <div className="pill-row">
            <Chip indicator={sev.labelCheck(check.severity, check.headline)} />
            {check.claim_max_mg !== null && (
              <Fact>
                {fmtMg(check.measured_mg_per_serving)} mg measured vs{' '}
                {fmtMg(check.claim_max_mg)} mg claimed
              </Fact>
            )}
          </div>
          <p className="hero-sub">{check.detail}</p>
        </div>
      ) : (
        <p className="hero-sub" style={{ marginTop: 0 }}>
          {check
            ? `${fmtMg(check.measured_mg_per_serving)} mg per ${REFERENCE_SERVING_ML} mL serving. No sodium claim was declared for this bowl, so there is nothing to check it against.`
            : 'No bites measured yet.'}
        </p>
      )}
    </section>
  );
}
