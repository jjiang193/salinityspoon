import { useEffect, useState } from 'react';

interface FoodMatrix {
  id: string;
  name: string;
  correction_factor: number;
  description: string;
}

export function FoodMatrixSelector({ activeMealId, onChange }: { activeMealId: number | null, onChange: () => void }) {
  const [matrices, setMatrices] = useState<FoodMatrix[]>([]);
  const [activeMatrix, setActiveMatrix] = useState<string>('default');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/food-matrices`)
      .then(r => r.json())
      .then(data => setMatrices(data))
      .catch(console.error);
  }, []);

  const applyMatrix = async (matrixId: string) => {
    if (!activeMealId) return;
    setLoading(true);
    setActiveMatrix(matrixId);
    try {
      await fetch(`/api/meals/active/matrix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matrix_id: matrixId })
      });
      onChange(); // Trigger parent refresh
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const selected = matrices.find(m => m.id === activeMatrix);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0, marginBottom: '1rem', color: 'var(--text-primary)' }}>Food Matrix Calibration</h2>
      <p className="cap">
        Total ionic conductivity includes background minerals like potassium. Select your broth to apply a USDA-based correction factor and isolate the true sodium content.
      </p>
      
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {matrices.map(m => (
          <button
            key={m.id}
            onClick={() => applyMatrix(m.id)}
            disabled={!activeMealId || loading}
            style={{
              padding: '6px 12px',
              borderRadius: '16px',
              border: activeMatrix === m.id ? '2px solid var(--series-salinity)' : '1px solid var(--border)',
              background: activeMatrix === m.id ? 'var(--band-fill)' : 'var(--plane)',
              color: 'var(--text-primary)',
              cursor: (!activeMealId || loading) ? 'not-allowed' : 'pointer',
              fontWeight: activeMatrix === m.id ? 'bold' : 'normal'
            }}
          >
            {m.name}
          </button>
        ))}
      </div>

      {selected && (
        <div style={{ padding: '0.75rem', background: 'var(--plane)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '0.85rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Correction Factor:</strong> <span style={{ color: 'var(--text-primary)' }}>{selected.correction_factor.toFixed(2)}x</span> <br/>
          <span style={{ color: 'var(--text-secondary)' }}>{selected.description}</span>
        </div>
      )}
    </div>
  );
}
