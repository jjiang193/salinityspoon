import { useState } from 'react';
import { HealthLog } from '../types';
import { useApi } from '../hooks/useApi';
import { sendJson } from '../lib/api';
import { dayAndTime } from '../lib/time';

const VISIBLE = 8;

/**
 * NaTrack's HealthLog: blood pressure, weight and notes, recorded by the patient.
 *
 * It sits beside the sodium numbers because that is the conversation a clinician
 * is having - what went in, and what the body did. Nothing here interprets a
 * reading. There is no "high" chip on a blood pressure: a threshold for one
 * patient is wrong for the next, and this is a logbook, not a monitor.
 *
 * Range checks live on the server (a systolic of 400 is a typo); the form shows
 * the server's message rather than keeping its own copy of the bounds.
 */
export function HealthLogCard({ patientId, editable, revision, onChange }: {
  patientId: string;
  /** The patient writes; the clinician reads. */
  editable: boolean;
  revision: number;
  onChange?: () => void;
}) {
  const { data } = useApi<HealthLog[]>(`/v1/patients/${patientId}/health-log`, revision);
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await sendJson('POST', `/v1/patients/${patientId}/health-log`, {
        systolic: num(systolic), diastolic: num(diastolic),
        weightKg: num(weight), note: note.trim() || null,
      });
      setSystolic(''); setDiastolic(''); setWeight(''); setNote('');
      onChange?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not save that reading.');
    } finally {
      setSaving(false);
    }
  }

  const entries = (data ?? []).slice(0, VISIBLE);

  return (
    <section className="card">
      <h2>Health log</h2>
      <p className="cap">
        {editable
          ? 'Blood pressure, weight or a note · your care team sees what you log here'
          : 'Logged by the patient · recorded as entered, not interpreted'}
      </p>

      {editable && (
        <form onSubmit={submit}>
          <div className="form-row">
            <input className="field field-sm" inputMode="numeric" placeholder="Systolic"
                   aria-label="Systolic blood pressure, mmHg"
                   value={systolic} onChange={(e) => setSystolic(e.target.value)} />
            <span className="unit-sep">/</span>
            <input className="field field-sm" inputMode="numeric" placeholder="Diastolic"
                   aria-label="Diastolic blood pressure, mmHg"
                   value={diastolic} onChange={(e) => setDiastolic(e.target.value)} />
            <input className="field field-sm" inputMode="decimal" placeholder="Weight kg"
                   aria-label="Body weight, kilograms"
                   value={weight} onChange={(e) => setWeight(e.target.value)} />
          </div>
          <div className="form-row" style={{ marginTop: 8 }}>
            <input className="field" placeholder="Note (optional)" aria-label="Note"
                   value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Log'}
            </button>
          </div>
        </form>
      )}
      {message && <p className="form-note">{message}</p>}

      {entries.length === 0 ? (
        <p className="empty">Nothing logged yet.</p>
      ) : (
        <div className="scroller"><table style={{ marginTop: editable ? 16 : 0 }}>
          <thead>
            <tr>
              <th>When</th>
              <th className="num">Blood pressure</th>
              <th className="num pad">Weight</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((h) => (
              <tr key={h.id}>
                <td className="primary nowrap">{dayAndTime(h.timestamp)}</td>
                <td className="num primary nowrap">
                  {h.systolic !== null ? <>{h.systolic}/{h.diastolic} <small className="muted">mmHg</small></>
                                       : <span className="muted">—</span>}
                </td>
                <td className="num pad nowrap">
                  {h.weightKg !== null ? <>{h.weightKg.toFixed(1)} <small className="muted">kg</small></>
                                       : <span className="muted">—</span>}
                </td>
                <td>{h.note ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
