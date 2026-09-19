import { useEffect, useRef, useState } from 'react';
import { LabelCheck, LabelClaimOption } from '../types';
import * as sev from '../lib/severity';
import { Chip, Fact } from './Chip';

interface Props {
  check: LabelCheck | null;
  activeMealId: number | null;
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
 */
export function LabelCheckCard({ check, activeMealId }: Props) {
  const [claims, setClaims] = useState<LabelClaimOption[]>([]);
  const [selected, setSelected] = useState('none');
  const [product, setProduct] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Once the user starts typing, stop overwriting their edit with server state.
  const edited = useRef(false);

  useEffect(() => {
    fetch('/api/label-claims')
      .then((r) => r.json())
      .then((d) => setClaims(d.claims))
      .catch(() => setClaims([]));
  }, []);

  // Reflect the claim the server is actually checking against. Without this the
  // dropdown reads "No claim" while a flag is firing, which reads as a bug.
  useEffect(() => {
    if (edited.current || !check) return;
    setSelected(check.claim);
    if (check.product_name) setProduct(check.product_name);
  }, [check?.claim, check?.product_name]);

  async function apply() {
    setSaving(true);
    setNote(null);
    try {
      const res = await fetch('/api/meals/label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_name: product.trim() || null,
          label_claim: selected,
        }),
      });
      if (res.status === 409) {
        setNote('Log a bite first — there is no meal in progress to label.');
      } else if (!res.ok) {
        setNote('Could not set the label.');
      } else {
        edited.current = false;
        setNote('Label applied. It is checked against every bite from now on.');
      }
    } catch {
      setNote('Could not reach the backend.');
    } finally {
      setSaving(false);
    }
  }

  const tier = sev.labelSeverity(check?.severity ?? 'none');

  return (
    <section className="card">
      <h2>Label check</h2>
      <p className="cap">
        {check?.product_name
          ? <>Checking <strong style={{ color: 'var(--text-primary)' }}>{check.product_name}</strong> against its label</>
          : 'Declare what is being measured, and every bite is checked against its claim'}
      </p>

      <div className="form-row">
        <input
          className="field"
          placeholder="Product name (optional)"
          value={product}
          onChange={(e) => { edited.current = true; setProduct(e.target.value); }}
        />
        <select
          className="field"
          value={selected}
          onChange={(e) => { edited.current = true; setSelected(e.target.value); }}
        >
          {claims.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
              {c.max_sodium_mg_per_serving !== null && ` (≤ ${c.max_sodium_mg_per_serving} mg)`}
            </option>
          ))}
        </select>
        <button className="btn" onClick={apply} disabled={saving || activeMealId === null}>
          {saving ? 'Applying…' : 'Apply'}
        </button>
      </div>
      {note && <p className="form-note">{note}</p>}

      {check && check.claim !== 'none' ? (
        <div style={{ marginTop: 18 }}>
          <div className="pill-row">
            <Chip indicator={{
              tier,
              label: check.headline,
              role: tier === 'attention' ? 'critical' : undefined,
            }} />
            {check.claim_max_mg !== null && (
              <Fact>
                {check.measured_mg_per_serving.toFixed(0)} mg measured vs{' '}
                {check.claim_max_mg.toFixed(0)} mg claimed
              </Fact>
            )}
          </div>
          <p className="hero-sub">{check.detail}</p>
        </div>
      ) : (
        <p className="hero-sub" style={{ marginTop: 18 }}>
          {check
            ? `${check.measured_mg_per_serving.toFixed(0)} mg per 240 mL serving. Set a label claim above to check it.`
            : 'No bites measured yet.'}
        </p>
      )}
    </section>
  );
}
