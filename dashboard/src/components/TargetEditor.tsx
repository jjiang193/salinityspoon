import { useEffect, useState } from 'react';
import { Patient } from '../types';
import { errorText, sendJson } from '../lib/api';
import { AHA_IDEAL_LIMIT_MG, FDA_DAILY_LIMIT_MG, fmtMg } from '../lib/sodium';

const PRESETS = [AHA_IDEAL_LIMIT_MG, 2000, FDA_DAILY_LIMIT_MG];

/**
 * The one thing a clinician writes rather than reads.
 *
 * The target is the denominator of every percentage the patient sees, so it is
 * set here and nowhere else. Bounds are enforced by the server (500-5,000 mg);
 * this form shows the server's message rather than keeping its own copy of them.
 *
 * A clinician types "1,800" as readily as "1800", so grouping commas and spaces
 * are read as the number they mean. Anything else is said to be not a number,
 * rather than answered with a Save button that silently stopped working.
 */
export function TargetEditor({ patient, onSaved }: { patient: Patient; onSaved: () => void }) {
  const [value, setValue] = useState(fmtMg(patient.sodiumTarget));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Two effects on purpose. The field follows the stored target; the note is
  // cleared only by a change of patient. Saving refetches the patient, and one
  // effect on both wiped "Saved." the moment the new target arrived.
  useEffect(() => {
    setValue(fmtMg(patient.sodiumTarget));
  }, [patient.patientId, patient.sodiumTarget]);
  useEffect(() => {
    setNote(null);
  }, [patient.patientId]);

  const text = value.replace(/[,\s]/g, '');
  const mg = text === '' ? NaN : Number(text);
  const valid = Number.isFinite(mg);
  const dirty = valid && mg !== patient.sodiumTarget;
  const first = patient.name.split(' ')[0];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    try {
      await sendJson('PUT', `/v1/patients/${patient.patientId}/target`, { sodiumTarget: mg });
      setNote(`Saved. ${first} sees ${fmtMg(mg)} mg from now on.`);
      onSaved();
    } catch (err) {
      setNote(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2>Daily sodium target</h2>
      <p className="cap">
        Every limit {first} sees is measured against this number
      </p>
      <form onSubmit={save}>
        <div className="form-row">
          <input className="field field-sm" inputMode="numeric" value={value}
                 onChange={(e) => { setValue(e.target.value); setNote(null); }}
                 aria-invalid={!valid}
                 aria-describedby={valid ? undefined : 'target-hint'}
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
                  aria-pressed={mg === p}
                  onClick={() => { setValue(fmtMg(p)); setNote(null); }}>
            {fmtMg(p)}
            {p === AHA_IDEAL_LIMIT_MG && ' · AHA ideal'}
            {p === FDA_DAILY_LIMIT_MG && ' · FDA limit'}
          </button>
        ))}
      </div>
      {!valid && (
        <p className="form-note" id="target-hint">
          Enter a number of milligrams, for example 1,800.
        </p>
      )}
      {/* Always mounted, so a screen reader hears the note when it arrives. */}
      <p className="form-note receipt" role="status">{valid && note}</p>
    </section>
  );
}
