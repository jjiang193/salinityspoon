 

export function SystemLimitsCard() {
  return (
    <details className="card diag" open style={{ border: '1px solid var(--border)' }}>
      <summary style={{ fontWeight: 'bold', fontSize: '13px', color: 'var(--text-primary)' }}>System Boundaries (What We Cannot Do Yet)</summary>
      <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', color: 'var(--text-secondary)' }}>
        <p>
          To ensure scientific integrity, this device operates within strict engineering constraints. 
          Here is what we currently cannot do:
        </p>
        <ul style={{ paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <li>
            <strong>0–40 °C Envelope:</strong> The device will reject readings from liquids hotter than 40 °C. Temperature compensation curves are not fully characterized beyond this point, and we refuse to log inaccurate data.
          </li>
          <li>
            <strong>Total Ionic Conductivity:</strong> We measure total ionic conductivity, not just sodium. Background ions (like Potassium in broths) inflate readings. We mitigate this using our USDA Food Matrix correction, but it is not a true ion-selective electrode.
          </li>
          <li>
            <strong>Volumetric Variation:</strong> We cannot use a load cell on a wet spoon. We assume a calibrated volume per bite, which carries a ±25% statistical variance per bite that cancels out to roughly ±10% over the course of a full meal.
          </li>
          <li>
            <strong>Behavioral Blindspot:</strong> The IMU can detect a scoop, but it cannot definitively distinguish a scoop eaten from a scoop poured back into the bowl.
          </li>
          <li>
            <strong>Dry Solids:</strong> The probe relies on an aqueous solution. Sodium in dry foods (like crackers or bread) cannot be measured and must be logged manually.
          </li>
        </ul>
      </div>
    </details>
  );
}
