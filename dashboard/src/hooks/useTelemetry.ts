import { useEffect, useRef, useState } from 'react';
import {
  Bite, ChartPoint, IntakeToday, LiveMessage, Meal, MealTotals,
  QUALITY_THRESHOLD, Sample,
} from '../types';

/** ~2 minutes of history at the 10 Hz publish rate. */
const MAX_POINTS = 1200;

/** The spoon publishes faster than React should repaint. Buffer and flush. */
const FLUSH_MS = 200;

const MAX_RECENT_BITES = 40;

export interface TelemetryState {
  connected: boolean;
  latest: Sample | null;
  points: ChartPoint[];
  bites: Bite[];
  activeMealId: number | null;
  mealTotals: MealTotals | null;
  meals: Meal[];
  intake: IntakeToday | null;
  lastError: string | null;
  /** Temperature of the last reading taken *in* the liquid, not in air. */
  lastSubmergedTempC: number | null;
  /** Whether that reading was inside the probe's range. Null until first dip. */
  lastSubmergedInRange: boolean | null;
}

function toPoint(msg: Extract<LiveMessage, { type: 'sample' }>): ChartPoint {
  const d = msg.data;
  const saltPct = d.salinity_g_l / 10;
  const counts = d.submerged && d.temp_in_range && d.quality >= QUALITY_THRESHOLD;
  return {
    t: new Date(msg.received_at).getTime(),
    ec25_ms_cm: d.ec25_ms_cm,
    salinity_g_l: d.salinity_g_l,
    salt_pct: saltPct,
    temp_c: d.temp_c,
    temp_in_range: d.temp_in_range,
    quality: d.quality,
    submerged: d.submerged,
    state: d.state,
    measured_salt_pct: d.submerged ? saltPct : null,
    trusted_salt_pct: counts ? saltPct : null,
  };
}

export function useTelemetry(): TelemetryState {
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState<Sample | null>(null);
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [bites, setBites] = useState<Bite[]>([]);
  const [activeMealId, setActiveMealId] = useState<number | null>(null);
  const [mealTotals, setMealTotals] = useState<MealTotals | null>(null);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [intake, setIntake] = useState<IntakeToday | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSubmergedTempC, setLastSubmergedTempC] = useState<number | null>(null);
  const [lastSubmergedInRange, setLastSubmergedInRange] = useState<boolean | null>(null);

  const buffer = useRef<ChartPoint[]>([]);
  const pendingLatest = useRef<Sample | null>(null);
  const pendingSubmerged = useRef<{ temp: number | null; inRange: boolean } | null>(null);

  async function refreshHistory() {
    try {
      const [m, i] = await Promise.all([
        fetch('/api/meals?limit=25').then((r) => r.json()),
        fetch('/api/intake/today').then((r) => r.json()),
      ]);
      setMeals(m);
      setIntake(i);
    } catch {
      // A dead backend already shows as a disconnected socket; no need to
      // shout about it twice.
    }
  }

  useEffect(() => {
    refreshHistory();

    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws/live`);

      ws.onopen = () => setConnected(true);

      ws.onmessage = (ev) => {
        const msg: LiveMessage = JSON.parse(ev.data);
        switch (msg.type) {
          case 'sample':
            pendingLatest.current = msg.data;
            buffer.current.push(toPoint(msg));
            if (msg.data.submerged) {
              // Latch it. A dip lasts well under a second; without this the
              // out-of-range warning would flash and vanish before it is read.
              pendingSubmerged.current = {
                temp: msg.data.temp_c,
                inRange: msg.data.temp_in_range,
              };
            }
            break;
          case 'bite':
            setBites((prev) => [msg.data, ...prev].slice(0, MAX_RECENT_BITES));
            setMealTotals(msg.meal_totals);
            setActiveMealId(msg.meal_id);
            setLastError(null);
            refreshHistory();
            break;
          case 'meal_started':
            setActiveMealId(msg.meal_id);
            setMealTotals(null);
            break;
          case 'meal_ended':
            setActiveMealId(null);
            refreshHistory();
            break;
          case 'error':
            // Interlock refusals arrive here. Surfacing them is the point:
            // a silently dropped bite looks like a broken sensor.
            setLastError(msg.detail);
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };

    connect();

    const flush = setInterval(() => {
      if (pendingLatest.current) {
        setLatest(pendingLatest.current);
        pendingLatest.current = null;
      }
      if (pendingSubmerged.current) {
        setLastSubmergedTempC(pendingSubmerged.current.temp);
        setLastSubmergedInRange(pendingSubmerged.current.inRange);
        pendingSubmerged.current = null;
      }
      if (buffer.current.length) {
        const incoming = buffer.current;
        buffer.current = [];
        setPoints((prev) => [...prev, ...incoming].slice(-MAX_POINTS));
      }
    }, FLUSH_MS);

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      clearInterval(flush);
      ws?.close();
    };
  }, []);

  return {
    connected, latest, points, bites, activeMealId,
    mealTotals, meals, intake, lastError,
    lastSubmergedTempC, lastSubmergedInRange,
  };
}
