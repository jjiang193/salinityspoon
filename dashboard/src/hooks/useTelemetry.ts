import { useEffect, useRef, useState } from 'react';
import {
  Bite, ChartPoint, LabelCheck, LiveMessage, Meal, MealTotals,
  QUALITY_THRESHOLD, Sample,
} from '../types';
import { getJson } from '../lib/api';

/** ~2 minutes of history at the 10 Hz publish rate. */
const MAX_POINTS = 1200;

/** The spoon publishes faster than React should repaint. Buffer and flush. */
const FLUSH_MS = 200;

const MAX_RECENT_BITES = 40;

/**
 * One patient's live session: NaTrack's /session/{patientId}.
 *
 * The socket carries that patient's bites and meals and nothing about anyone
 * else. Stored data (today's intake, history) is not here - it is fetched with
 * useApi, and refetched whenever `revision` moves.
 */
export interface TelemetryState {
  /** The session socket is open. Says nothing about the spoon. */
  connected: boolean;
  /** This patient holds the spoon: samples and bites will arrive here. */
  holder: boolean;
  /** Someone else is mid-meal with the spoon. Deliberately anonymous. */
  spoonBusyElsewhere: boolean;
  latest: Sample | null;
  points: ChartPoint[];
  bites: Bite[];
  activeMealId: number | null;
  mealTotals: MealTotals | null;
  lastError: string | null;
  /** Temperature of the last reading taken *in* the liquid, not in air. */
  lastSubmergedTempC: number | null;
  /** Whether that reading was inside the probe's range. Null until first dip. */
  lastSubmergedInRange: boolean | null;
  labelCheck: LabelCheck | null;
  /** Moves whenever stored data has changed. Depend on it to refetch. */
  revision: number;
  /** For writes the socket does not announce, such as a manual entry. */
  bump: () => void;
}

function toPoint(msg: Extract<LiveMessage, { type: 'sample' }>): ChartPoint {
  const d = msg.data;
  const saltPct = d.salinity_g_l / 10;
  const counts = d.submerged && d.temp_in_range && d.quality >= QUALITY_THRESHOLD;
  return {
    t: new Date(msg.received_at).getTime(),
    salinityIndex: d.salinityIndex,
    salinity_g_l: d.salinity_g_l,
    salt_pct: saltPct,
    tempC: d.tempC,
    temp_in_range: d.temp_in_range,
    quality: d.quality,
    submerged: d.submerged,
    state: d.state,
    measured_salt_pct: d.submerged ? saltPct : null,
    trusted_salt_pct: counts ? saltPct : null,
  };
}

const biteKey = (b: Bite) => `${b.deviceId}-${b.bite_id}-${b.timestamp}`;

/** Pass null for a view with no patient in it; nothing connects. */
export function useTelemetry(patientId: string | null): TelemetryState {
  const [connected, setConnected] = useState(false);
  const [holder, setHolder] = useState(false);
  const [spoonBusyElsewhere, setSpoonBusyElsewhere] = useState(false);
  const [latest, setLatest] = useState<Sample | null>(null);
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [bites, setBites] = useState<Bite[]>([]);
  const [activeMealId, setActiveMealId] = useState<number | null>(null);
  const [mealTotals, setMealTotals] = useState<MealTotals | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSubmergedTempC, setLastSubmergedTempC] = useState<number | null>(null);
  const [lastSubmergedInRange, setLastSubmergedInRange] = useState<boolean | null>(null);
  const [labelCheck, setLabelCheck] = useState<LabelCheck | null>(null);
  const [revision, setRevision] = useState(0);

  const buffer = useRef<ChartPoint[]>([]);
  const pendingLatest = useRef<Sample | null>(null);
  const pendingSubmerged = useRef<{ temp: number | null; inRange: boolean } | null>(null);

  const bump = () => setRevision((r) => r + 1);

  useEffect(() => {
    // A different patient is a different session. Nothing carries over: the
    // last person's soup must not be on this person's screen for even a frame.
    setConnected(false); setHolder(false); setSpoonBusyElsewhere(false);
    setLatest(null); setPoints([]); setBites([]);
    setActiveMealId(null); setMealTotals(null); setLastError(null);
    setLastSubmergedTempC(null); setLastSubmergedInRange(null); setLabelCheck(null);
    buffer.current = []; pendingLatest.current = null; pendingSubmerged.current = null;

    if (patientId === null) return;

    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let backfilled: number | null = null;

    // Opening the dashboard mid-meal should not show an empty chart beside a
    // large total. Backfill the open meal's bites once, from the server.
    async function backfill(mealId: number) {
      if (backfilled === mealId) return;
      backfilled = mealId;
      try {
        const detail = await getJson<{ meal: Meal; bites: Bite[] }>(`/api/meals/${mealId}`);
        if (closed) return;
        const past = detail.bites.slice(-MAX_RECENT_BITES).reverse();
        if (!past.length) return;
        setMealTotals((live) => live ?? detail.meal);
        // Live bites may already have arrived; keep them ahead of history.
        setBites((live) => {
          const seen = new Set(live.map(biteKey));
          return [...live, ...past.filter((b) => !seen.has(biteKey(b)))]
            .slice(0, MAX_RECENT_BITES);
        });
      } catch {
        /* the chart simply starts from live bites instead */
      }
    }

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/session/${patientId}`);

      ws.onopen = () => setConnected(true);

      ws.onmessage = (ev) => {
        const msg: LiveMessage = JSON.parse(ev.data);
        switch (msg.type) {
          case 'spoon':
            setHolder(msg.holder);
            setSpoonBusyElsewhere(msg.busy);
            setActiveMealId(msg.mealId);
            if (msg.mealId !== null) backfill(msg.mealId);
            if (!msg.holder) { setLatest(null); pendingLatest.current = null; }
            break;
          case 'sample':
            pendingLatest.current = msg.data;
            buffer.current.push(toPoint(msg));
            if (msg.data.submerged) {
              // Latch it. A dip lasts well under a second; without this the
              // out-of-range warning would flash and vanish before it is read.
              pendingSubmerged.current = {
                temp: msg.data.tempC,
                inRange: msg.data.temp_in_range,
              };
            }
            break;
          case 'bite':
            setBites((prev) => (prev.some((b) => biteKey(b) === biteKey(msg.data))
              ? prev
              : [msg.data, ...prev].slice(0, MAX_RECENT_BITES)));
            setMealTotals(msg.meal_totals);
            setActiveMealId(msg.mealId);
            setLastError(null);
            if (msg.label_check) setLabelCheck(msg.label_check);
            bump();
            break;
          case 'meal_started':
            setActiveMealId(msg.mealId);
            setMealTotals(null);
            setLabelCheck(null);
            setBites([]);
            bump();
            break;
          case 'meal_ended':
            setActiveMealId(null);
            bump();
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
  }, [patientId]);

  return {
    connected, holder, spoonBusyElsewhere, latest, points, bites, activeMealId,
    mealTotals, lastError, lastSubmergedTempC, lastSubmergedInRange,
    labelCheck, revision, bump,
  };
}
