import { useEffect, useState } from 'react';
import { Patient } from '../types';
import { sendJson } from '../lib/api';
import { AHA_IDEAL_LIMIT_MG, FDA_DAILY_LIMIT_MG } from '../lib/sodium';

const PRESETS = [AHA_IDEAL_LIMIT_MG, 2000, FDA_DAILY_LIMIT_MG];

/**
 * The one thing a clinician writes rather than reads.
 *
 * The target is the denominator of every percentage the patient sees, so it is
 * set here and nowhere else. Bounds are enforced by the server (500-5,000 mg);
 * this form shows the server's message rather than keeping its own copy of them.
 */
export function TargetEditor({ patient, onSaved }: { patient: Patient; onSaved: () => void }) {
  const [value, setValue] = useState(String(patient.sodiumTarget));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setValue(String(patient.sodiumTarget));
    setNote(null);
  }, [patient.patientId, patient.sodiumTarget]);

  const mg = Number(value);
  const dirty = Number.isFinite(mg) && mg !== patient.sodiumTarget;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    try {
      await sendJson('PUT', `/v1/patients/${patient.patientId}/target`, { sodiumTarget: mg });
      setNote('Saved. The patient sees the new target immediately.');
      onSaved();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2>Daily sodium target</h2>
      <p className="cap">
        Every limit {patient.name.split(' ')[0]} sees is measured against this number
      </p>
      <form onSubmit={save}>
        <div className="form-row">
          <input className="field field-sm" inputMode="numeric" value={value}
                 onChange={(e) => setValue(e.target.value)}
                 aria-label="Daily sodium target in milligrams" />
          <span className="unit-suffix">mg / day</span>
          <button className="btn" type="submit" disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
      <div className="pill-row" style={{ marginTop: 12 }}>
        {PRESETS.map((p) => (
          <button key={p} type="button" className="pill pill-btn"
                  aria-pressed={mg === p} onClick={() => setValue(String(p))}>
            {p.toLocaleString()}
            {p === AHA_IDEAL_LIMIT_MG && ' · AHA ideal'}
            {p === FDA_DAILY_LIMIT_MG && ' · FDA limit'}
          </button>
        ))}
      </div>
      {note && <p className="form-note">{note}</p>}
    </section>
  );
}
