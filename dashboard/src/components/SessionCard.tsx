import { useEffect, useState } from 'react';
import { LabelClaimOption } from '../types';
import { sendJson } from '../lib/api';

interface Props {
  patientId: string;
  /** The open meal, if it is this patient's. */
  activeMealId: number | null;
  /** True when someone else is mid-meal with the spoon. */
  spoonBusyElsewhere: boolean;
  connected: boolean;
  onChange: () => void;
}

/**
 * Starting and ending a meal.
 *
 * The spoon still opens a meal by itself on the first bite - nobody should have
 * to press a button to eat. Starting one here does two things that path cannot:
 * it puts the meal against the right patient, and it lets the label be declared
 * up front, so the label check runs from the first bite instead of from
 * whenever someone remembers.
 */
export function SessionCard({
  patientId, activeMealId, spoonBusyElsewhere, connected, onChange,
}: Props) {
  const [claims, setClaims] = useState<LabelClaimOption[]>([]);
  const [product, setProduct] = useState('');
  const [claim, setClaim] = useState('none');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/label-claims')
      .then((r) => r.json())
      .then((d) => setClaims(d.claims))
      .catch(() => setClaims([]));
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setNote(null);
    try {
      await action();
      onChange();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not reach the backend.');
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(async () => {
    await sendJson('POST', '/api/meals/start', {
      patientId,
      product_name: product.trim() || null,
      label_claim: claim,
    });
    setProduct('');
    setClaim('none');
  });

  const end = () => run(() => sendJson('POST', '/api/meals/close', {}));

  if (activeMealId !== null) {
    return (
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Meal in progress</h2>
            <p className="cap" style={{ margin: 0 }}>
              Meal #{activeMealId} · every dip is logged to you. It also ends by itself
              after 20 minutes without a bite.
            </p>
          </div>
          <button className="btn btn-quiet" onClick={end} disabled={busy}>
            {busy ? 'Ending…' : 'End meal'}
          </button>
        </div>
        {note && <p className="form-note">{note}</p>}
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Start a meal</h2>
      <p className="cap">
        Say what is in the bowl and its label is checked from the first bite. Optional —
        dipping the spoon starts a meal too.
      </p>
      <div className="form-row">
        <input className="field" placeholder="What are you eating? (optional)"
               value={product} onChange={(e) => setProduct(e.target.value)}
               aria-label="What are you eating" />
        <select className="field" value={claim} onChange={(e) => setClaim(e.target.value)}
                aria-label="Sodium claim on the label">
          {claims.map((c) => (
            <option key={c.value} value={c.value}>
              {c.value === 'none' ? 'No sodium claim on label' : `Label says: ${c.label.toLowerCase()}`}
            </option>
          ))}
        </select>
        <button className="btn" onClick={start} disabled={busy || spoonBusyElsewhere}>
          {busy ? 'Starting…' : 'Start meal'}
        </button>
      </div>
      {spoonBusyElsewhere && (
        <p className="form-note">
          The spoon is in the middle of another patient's meal. It frees up when that meal ends.
        </p>
      )}
      {!connected && !spoonBusyElsewhere && (
        <p className="form-note">
          The spoon is not connected. You can start the meal; bites appear once it is back.
        </p>
      )}
      {note && <p className="form-note">{note}</p>}
    </section>
  );
}
