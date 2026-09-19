import { useEffect, useState } from 'react';
import { ManualMeal } from '../types';
import { shortTime } from '../lib/time';

/**
 * The spoon only reads liquids. Without this the daily total is blind to bread,
 * crackers, cheese — most of what actually carries dietary sodium.
 *
 * Kept visibly separate from measured bites. Partial monitoring you are honest
 * about beats a total that quietly under-reports.
 */
export function ManualMealForm({ onChange }: { onChange: () => void }) {
  const [entries, setEntries] = useState<ManualMeal[]>([]);
  const [name, setName] = useState('');
  const [portion, setPortion] = useState('');
  const [sodium, setSodium] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setEntries(await fetch('/api/manual-meals?limit=10').then((r) => r.json()));
    } catch {
      /* the connection pill already reports a dead backend */
    }
  }

  useEffect(() => { refresh(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const mg = Number(sodium);
    if (!name.trim()) return setError('Name is required.');
    if (!Number.isFinite(mg) || mg < 0) return setError('Sodium must be a positive number.');

    setError(null);
    const res = await fetch('/api/manual-meals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        portion: portion.trim() || null,
        sodium_mg: mg,
      }),
    });
    if (!res.ok) return setError('Could not save that entry.');

    setName(''); setPortion(''); setSodium('');
    await refresh();
    onChange();
  }

  async function remove(id: number) {
    await fetch(`/api/manual-meals/${id}`, { method: 'DELETE' });
    await refresh();
    onChange();
  }

  return (
    <section className="card">
      <h2>Log solid food</h2>
      <p className="caption">
        Self-reported · the probe reads liquids only, so solids are entered by hand
      </p>

      <form onSubmit={submit}>
        <div className="form-row">
          <input className="field" placeholder="Food" value={name}
                 onChange={(e) => setName(e.target.value)} />
          <input className="field field-sm" placeholder="Portion" value={portion}
                 onChange={(e) => setPortion(e.target.value)} />
          <input className="field field-sm" placeholder="mg Na" inputMode="decimal"
                 value={sodium} onChange={(e) => setSodium(e.target.value)} />
          <button className="btn" type="submit">Add</button>
        </div>
      </form>
      {error && <p className="form-note">{error}</p>}

      {entries.length > 0 && (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Time</th><th>Food</th><th>Portion</th>
              <th className="num">Sodium</th><th className="num"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{shortTime(e.ts_utc)}</td>
                <td className="primary">{e.name}</td>
                <td>{e.portion ?? '—'}</td>
                <td className="num primary">{e.sodium_mg.toFixed(0)} mg</td>
                <td className="num">
                  <button className="btn-link" onClick={() => remove(e.id)}
                          aria-label={`Remove ${e.name}`}>remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
