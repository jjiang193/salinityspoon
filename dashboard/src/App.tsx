import { useTelemetry } from './hooks/useTelemetry';
import { MealHero } from './components/MealHero';
import { SensorStatus } from './components/SensorStatus';
import { SalinityChart } from './components/SalinityChart';
import { TemperatureChart } from './components/TemperatureChart';
import { DailyMeter } from './components/DailyMeter';
import { BiteTable } from './components/BiteTable';
import { LabelCheckCard } from './components/LabelCheckCard';
import { ManualMealForm } from './components/ManualMealForm';
import { PROBE_TEMP_MAX_C } from './types';

export default function App() {
  const {
    connected, latest, points, bites, activeMealId,
    mealTotals, intake, lastError,
    lastSubmergedTempC, lastSubmergedInRange, labelCheck, refresh,
  } = useTelemetry();

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
        <span className="pill" data-status={connected ? 'good' : 'critical'}>
          <span className="dot">{connected ? '●' : '■'}</span>
          {connected ? 'Live' : 'Offline'}
        </span>
      </header>

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
        <SalinityChart points={points} />
        <TemperatureChart points={points} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <LabelCheckCard check={labelCheck} activeMealId={activeMealId} />
        <DailyMeter intake={intake} />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <ManualMealForm onChange={refresh} />
        <BiteTable bites={bites} />
      </div>
    </div>
  );
}
