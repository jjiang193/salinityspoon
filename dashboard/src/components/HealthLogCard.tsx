import { useId, useState } from 'react';
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
  /** The patient writes. The clinician's page reads the log through
   *  VitalsTimeline, which lists it with HealthLogTable below. */
  editable: boolean;
  revision: number;
  onChange?: () => void;
}) {
  // Polled, so a log that could not be read fills in once the server is back.
  const fetched = useApi<HealthLog[]>(`/v1/patients/${patientId}/health-log`, revision, 15000);
  const data = fetched.data;
  const error = fetched.error !== null;
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const systolicId = useId();
  const weightId = useId();
  const noteId = useId();

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
          {/* Visible labels, as on the food form beside it: a placeholder is gone
              the moment a number is typed, and "139 / 87  84" names nothing. */}
          <div className="form-row form-row-labelled form-row-top">
            <div className="field-group field-group-wide">
              <label htmlFor={systolicId}>Blood pressure (mmHg)</label>
              <div className="field-pair">
                <input id={systolicId} className="field" inputMode="numeric" placeholder="e.g. 128"
                       aria-label="Systolic blood pressure, mmHg" autoComplete="off"
                       value={systolic} onChange={(e) => setSystolic(e.target.value)} />
                <span className="unit-sep" aria-hidden="true">/</span>
                <input className="field" inputMode="numeric" placeholder="e.g. 82"
                       aria-label="Diastolic blood pressure, mmHg" autoComplete="off"
                       value={diastolic} onChange={(e) => setDiastolic(e.target.value)} />
              </div>
            </div>
            <div className="field-group">
              <label htmlFor={weightId}>Weight (kg)</label>
              <input id={weightId} className="field" inputMode="decimal" placeholder="e.g. 84.5"
                     autoComplete="off"
                     value={weight} onChange={(e) => setWeight(e.target.value)} />
            </div>
          </div>
          <div className="form-row form-row-labelled" style={{ marginTop: 10 }}>
            <div className="field-group">
              <label htmlFor={noteId}>Note (optional)</label>
              <input id={noteId} className="field" autoComplete="off"
                     value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button className="btn" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Log'}
            </button>
          </div>
        </form>
      )}
      {message && <p className="form-note">{message}</p>}

      {error && !data ? (
        // A log that could not be read is not an empty log.
        <p className="empty" role="status">Can't load the health log right now.</p>
      ) : entries.length === 0 ? (
        <p className="empty">{data ? 'Nothing logged yet.' : 'Loading…'}</p>
      ) : (
        <HealthLogTable entries={entries} style={{ marginTop: editable ? 16 : 0 }} />
      )}
    </section>
  );
}

/** The readings exactly as entered, newest first as given. */
export function HealthLogTable({ entries, style }: {
  entries: HealthLog[];
  style?: React.CSSProperties;
}) {
  return (
    <div className="scroller"><table style={style}>
      <thead>
        <tr>
          <th>When</th>
          <th className="num">
            <span className="hide-phone">Blood pressure</span><span className="show-phone">BP</span>
          </th>
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
  );
}
