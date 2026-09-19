import { useState } from 'react';
import { useTelemetry } from './hooks/useTelemetry';
import { MealHero } from './components/MealHero';
import { SensorStatus } from './components/SensorStatus';
import { SalinityChart } from './components/SalinityChart';
import { TemperatureChart } from './components/TemperatureChart';
import { DailyMeter } from './components/DailyMeter';
import { BiteTable } from './components/BiteTable';
import { BiteChart } from './components/BiteChart';
import { SodiumProjection } from './components/SodiumProjection';
import { LabelCheckCard } from './components/LabelCheckCard';
import { ManualMealForm } from './components/ManualMealForm';
import { Chip } from './components/Chip';
import { FoodMatrixSelector } from './components/FoodMatrixSelector';
import { EchoDebriefCard } from './components/EchoDebriefCard';
import { SystemLimitsCard } from './components/SystemLimitsCard';
import * as sev from './lib/severity';
import { PROBE_TEMP_MAX_C } from './types';

export default function App() {
  const {
    connected, latest, points, bites, activeMealId,
    mealTotals, intake, lastError,
    lastSubmergedTempC, lastSubmergedInRange, labelCheck, refresh,
  } = useTelemetry();

  const [activeTab, setActiveTab] = useState<'dashboard' | 'advanced'>('dashboard');

  // Keyed on the last reading taken IN the liquid. Between dips the probe reads
  // room air, which is in range and tells us nothing about the soup.
  const outOfRange = lastSubmergedInRange === false;

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Salinity Spoon</h1>
          <p className="sub">Salt in liquids, 0–{PROBE_TEMP_MAX_C} °C → sodium you can act on</p>
        </div>
        <Chip indicator={sev.connection(connected)} />
      </header>

      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--border)', margin: '0 0 20px 0' }}>
        <button 
          onClick={() => setActiveTab('dashboard')}
          style={{ 
            padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer',
            borderBottom: activeTab === 'dashboard' ? '3px solid var(--series-salinity)' : '3px solid transparent',
            color: activeTab === 'dashboard' ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontWeight: activeTab === 'dashboard' ? 'bold' : 'normal'
          }}
        >
          Dashboard
        </button>
        <button 
          onClick={() => setActiveTab('advanced')}
          style={{ 
            padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer',
            borderBottom: activeTab === 'advanced' ? '3px solid var(--series-salinity)' : '3px solid transparent',
            color: activeTab === 'advanced' ? 'var(--text-primary)' : 'var(--text-secondary)',
            fontWeight: activeTab === 'advanced' ? 'bold' : 'normal'
          }}
        >
          Advanced Analysis
        </button>
      </div>

      {outOfRange && (
        <div className="banner-warn">
          <strong>Liquid is out of the probe's range
          {lastSubmergedTempC !== null && ` — last measured ${lastSubmergedTempC.toFixed(1)} °C`}.</strong>{' '}
          The DFR0300 is rated 0–{PROBE_TEMP_MAX_C} °C. No bites will be logged until it
          cools — a reading taken outside that range is not less precise, it is
          unsupported.
        </div>
      )}

      {lastError && !outOfRange && (
        <div className="banner-warn"><strong>Last refusal:</strong> {lastError}</div>
      )}

      {activeTab === 'dashboard' ? (
        <>
          <div className="grid hero">
            <MealHero totals={mealTotals} activeMealId={activeMealId} />
            <div className="stack">
              <SensorStatus
              connected={connected}
              latest={latest}
              lastError={lastError}
              lastSubmergedTempC={lastSubmergedTempC}
              lastSubmergedInRange={lastSubmergedInRange}
            />
            </div>
          </div>

          <div className="grid two" style={{ marginTop: 16 }}>
            <BiteChart bites={bites} />
            <SodiumProjection bites={bites} intake={intake} />
          </div>

          <div className="grid two" style={{ marginTop: 16 }}>
            <LabelCheckCard check={labelCheck} activeMealId={activeMealId} />
            <DailyMeter intake={intake} />
          </div>

          <details className="card diag" style={{ marginTop: 16 }}>
            <summary>Signal diagnostics — sample-level traces</summary>
            <div className="grid two">
              <SalinityChart points={points} />
              <TemperatureChart points={points} />
            </div>
          </details>

          <div className="grid two" style={{ marginTop: 16 }}>
            <ManualMealForm onChange={refresh} />
            <BiteTable bites={bites} />
          </div>
        </>
      ) : (
        <div className="stack" style={{ gap: '16px' }}>
          <FoodMatrixSelector activeMealId={activeMealId} onChange={refresh} />
          <EchoDebriefCard activeMealId={activeMealId} />
          <SystemLimitsCard />
        </div>
      )}
    </div>
  );
}
