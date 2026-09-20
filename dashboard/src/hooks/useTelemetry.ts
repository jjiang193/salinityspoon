import { useEffect, useRef, useState } from 'react';
import {
  Bite, ChartPoint, LabelCheck, LiveMessage, Meal, MealTotals,
  QUALITY_THRESHOLD, Sample,
} from '../types';
import { getJson } from '../lib/api';
import { sessionUrl } from '../lib/cloud';

/** ~2 minutes of history at the 10 Hz publish rate. */
const MAX_POINTS = 1200;

/** The spoon publishes faster than React should repaint. Buffer and flush. */
const FLUSH_MS = 200;

const MAX_RECENT_BITES = 40;

/** No sample for this long and the spoon is treated as silent. It publishes at
 *  10 Hz, so three seconds is thirty missed samples - not a hiccup. */
const SILENT_MS = 3000;

/** How long after the probe leaves the liquid a bite may still arrive. The
 *  detector confirms and logs within about a second of the dip ending. */
const DIP_GRACE_MS = 1500;

/** Outside a meal, how long "too hot to measure" may stand on one reading. An
 *  out-of-range liquid never becomes a bite, so no meal opens and no meal_ended
 *  ever comes to clear it; without an age the refusal outlives the bowl by hours. */
const LATCH_MAX_AGE_MS = 60_000;

/**
 * What became of the last dip the viewer watched.
 *
 * A counted dip is a bite. A dip that was not counted otherwise leaves no trace
 * at all, which reads as a broken spoon - so it is said, with the reason.
 */
export type DipResult =
  | { at: number; counted: true; mg: number }
  | { at: number; counted: false; reason: 'out-of-range' | 'unsteady' };

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
  /** The server does not know this patient (close code 4404). Not retried. */
  notFound: boolean;
  /** This patient holds the spoon: samples and bites will arrive here. */
  holder: boolean;
  /** Someone else is mid-meal with the spoon. Deliberately anonymous. */
  spoonBusyElsewhere: boolean;
  /** A sample arrived within the last SILENT_MS. False is the frozen spoon:
   *  every live value on screen is then the last one, not the current one. */
  spoonLive: boolean;
  /** Whole seconds since the last sample. Null until one has been seen in this
   *  session - "never seen" and "gone quiet" are different things to say. Also
   *  null while the socket is shut: a spoon that cannot be heard is not silent. */
  silentForS: number | null;
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
  /** What the holder declared for the open meal. Null when no meal is open. */
  mealLabel: { product_name: string | null; label_claim: string } | null;
  /** The last dip seen in this session and whether it became a bite. */
  lastDip: DipResult | null;
  /** Dips this meal that did not become a bite. */
  dipsNotCounted: number;
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

/** A session nothing has been heard from yet. */
const EMPTY: Omit<TelemetryState, 'revision' | 'bump'> = {
  connected: false, notFound: false, holder: false, spoonBusyElsewhere: false,
  spoonLive: false, silentForS: null, latest: null, points: [], bites: [],
  activeMealId: null, mealTotals: null, lastError: null,
  lastSubmergedTempC: null, lastSubmergedInRange: null, labelCheck: null,
  mealLabel: null, lastDip: null, dipsNotCounted: 0,
};

const biteKey = (b: Bite) => `${b.deviceId}-${b.bite_id}-${b.timestamp}`;

/** Pass null for a view with no patient in it; nothing connects. */
export function useTelemetry(patientId: string | null): TelemetryState {
  const [connected, setConnected] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [spoonLive, setSpoonLive] = useState(false);
  const [silentForS, setSilentForS] = useState<number | null>(null);
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
  const [mealLabel, setMealLabel] = useState<TelemetryState['mealLabel']>(null);
  const [lastDip, setLastDip] = useState<DipResult | null>(null);
  const [dipsNotCounted, setDipsNotCounted] = useState(0);
  const [revision, setRevision] = useState(0);
  // Whose session the state above describes. See the return.
  const [forPatient, setForPatient] = useState<string | null>(patientId);

  const buffer = useRef<ChartPoint[]>([]);
  const pendingLatest = useRef<Sample | null>(null);
  const pendingSubmerged = useRef<{ temp: number | null; inRange: boolean } | null>(null);
  // What the latch last told React, so a meal boundary can tell a refusal from a bite.
  const latchedInRange = useRef<boolean | null>(null);
  const latchedAt = useRef<number | null>(null);
  // The open meal as the flush sees it; state is a render behind.
  const openMeal = useRef<number | null>(null);
  const lastSampleAt = useRef<number | null>(null);
  // What the flush last told React, so it only speaks when something changed.
  const shownLive = useRef(false);
  const shownSilentS = useRef<number | null>(null);
  // The dip in progress, or the one that has ended and is waiting for its bite.
  const dip = useRef<{ inRange: boolean; endedAt: number | null } | null>(null);
  const wasSubmerged = useRef(false);

  const bump = () => setRevision((r) => r + 1);

  useEffect(() => {
    // A different patient is a different session. Nothing carries over: the
    // last person's soup must not be on this person's screen for even a frame.
    setConnected(false); setHolder(false); setSpoonBusyElsewhere(false);
    setLatest(null); setPoints([]); setBites([]);
    setActiveMealId(null); setMealTotals(null); setLastError(null);
    setLastSubmergedTempC(null); setLastSubmergedInRange(null); setLabelCheck(null);
    setNotFound(false); setSpoonLive(false); setSilentForS(null);
    setMealLabel(null); setLastDip(null); setDipsNotCounted(0);
    buffer.current = []; pendingLatest.current = null; pendingSubmerged.current = null;
    lastSampleAt.current = null; shownLive.current = false; shownSilentS.current = null;
    dip.current = null; wasSubmerged.current = false; latchedInRange.current = null;
    latchedAt.current = null; openMeal.current = null;
    setForPatient(patientId);

    if (patientId === null) return;

    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let backfilled: number | null = null;
    let firstSample = true;
    let attempts = 0;

    const missDip = (reason: 'out-of-range' | 'unsteady') => {
      setLastDip({ at: Date.now(), counted: false, reason });
      setDipsNotCounted((n) => n + 1);
      dip.current = null;
    };

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
        // A stored bite can only exist if its liquid was in range. Without this
        // a page opened mid-meal says "not yet measured" beside a meal of
        // measured bites until the next dip. A dip watched since then wins.
        if (latchedInRange.current === null && pendingSubmerged.current === null) {
          setLastSubmergedTempC(past[0].tempC); setLastSubmergedInRange(true);
          latchedInRange.current = true; latchedAt.current = Date.now();
        }
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
      attempts += 1;
      ws = new WebSocket(sessionUrl(patientId));

      ws.onopen = () => {
        firstSample = true;
        setConnected(true);
        // Opening on anything but the first try means the server was away -
        // before this page loaded or during it. Fetches that failed meanwhile
        // are keyed on the revision and would otherwise never be asked again:
        // "Server connected" above "Could not load this patient".
        if (attempts > 1) bump();
      };

      ws.onmessage = (ev) => {
        const msg: LiveMessage = JSON.parse(ev.data);
        switch (msg.type) {
          case 'spoon':
            setHolder(msg.holder);
            setSpoonBusyElsewhere(msg.busy);
            setActiveMealId(msg.mealId); openMeal.current = msg.mealId;
            // The declared label rides on this message, so a tab opened
            // mid-meal - or after the label was changed elsewhere - shows this
            // meal's label and not the last one's.
            setMealLabel(msg.mealId !== null
              ? { product_name: msg.product_name ?? null, label_claim: msg.label_claim ?? 'none' }
              : null);
            if (msg.mealId !== null) {
              backfill(msg.mealId);
              if (msg.label_check !== undefined) setLabelCheck(msg.label_check);
            }
            if (!msg.holder) {
              // The spoon is someone else's now. Its silence is not ours to report.
              setLatest(null); pendingLatest.current = null;
              lastSampleAt.current = null; dip.current = null;
            }
            break;
          case 'sample': {
            const now = Date.now();
            pendingLatest.current = msg.data;
            buffer.current.push(toPoint(msg));
            // The first sample after connecting may be the server's primer: the
            // last sample it ever saw, possibly from a spoon switched off an
            // hour ago. It is dated by when it was received, not by now, and is
            // not a dip anyone watched.
            const receivedAt = new Date(msg.received_at).getTime();
            const primer = firstSample && now - receivedAt > SILENT_MS;
            firstSample = false;
            lastSampleAt.current = primer ? receivedAt : now;
            if (primer) break;

            // Follow the dip. A rejected dip sends nothing: the simulator goes
            // CONFIRM -> IDLE with no bite and never emits ABORT, so "not
            // counted" has to be inferred from a dip that ends and is not
            // followed by a bite. Real firmware's ABORT is honoured as well.
            const sub = msg.data.submerged;
            if (sub && !wasSubmerged.current) {
              // Straight back in before the last dip was answered: it was not.
              if (dip.current !== null) missDip(dip.current.inRange ? 'unsteady' : 'out-of-range');
              dip.current = { inRange: true, endedAt: null };
            }
            wasSubmerged.current = sub;
            if (dip.current !== null && dip.current.endedAt === null) {
              if (sub) dip.current.inRange = dip.current.inRange && msg.data.temp_in_range;
              if (!sub || msg.data.state === 'ABORT') dip.current.endedAt = now;
            }
            if (msg.data.submerged) {
              // Latch it. A dip lasts well under a second; without this the
              // out-of-range warning would flash and vanish before it is read.
              pendingSubmerged.current = {
                temp: msg.data.tempC,
                inRange: msg.data.temp_in_range,
              };
            }
            break;
          }
          case 'bite':
            setBites((prev) => (prev.some((b) => biteKey(b) === biteKey(msg.data))
              ? prev
              : [msg.data, ...prev].slice(0, MAX_RECENT_BITES)));
            setMealTotals(msg.meal_totals);
            setActiveMealId(msg.mealId); openMeal.current = msg.mealId;
            setLastError(null);
            if (msg.label_check) setLabelCheck(msg.label_check);
            // A bite with no dip open is the primer or a replay, not something
            // the viewer watched happen.
            if (dip.current !== null) {
              setLastDip({ at: Date.now(), counted: true, mg: msg.data.sodiumEstimate });
              dip.current = null;
            }
            bump();
            break;
          case 'meal_started':
            setActiveMealId(msg.mealId); openMeal.current = msg.mealId;
            setMealTotals(null);
            // A refusal latched before this meal describes some other bowl. A
            // new meal must not open under "too hot" before it has been dipped.
            // An in-range latch stays: it is the bite that opened this meal.
            if (latchedInRange.current === false || pendingSubmerged.current?.inRange === false) {
              setLastSubmergedTempC(null); setLastSubmergedInRange(null);
              pendingSubmerged.current = null; latchedInRange.current = null;
              latchedAt.current = null;
            }
            setLabelCheck(null);
            setMealLabel(null);
            setLastDip(null);
            setDipsNotCounted(0);
            setBites([]);
            bump();
            break;
          case 'meal_ended':
            setActiveMealId(null); openMeal.current = null;
            // The bowl is finished with; so is what was said about its temperature.
            setLastSubmergedTempC(null); setLastSubmergedInRange(null);
            pendingSubmerged.current = null; latchedInRange.current = null;
            latchedAt.current = null;
            setLastDip(null);
            bump();
            break;
          case 'error':
            // Interlock refusals arrive here. Surfacing them is the point:
            // a silently dropped bite looks like a broken sensor.
            setLastError(msg.detail);
            // The only session error is the server refusing a bite on
            // temperature, so the dip it answers was not counted.
            if (dip.current !== null) missDip('out-of-range');
            break;
        }
      };

      ws.onclose = (ev) => {
        // A socket closed by the cleanup below reports it late, after the next
        // patient's session has reset everything and opened its own. That
        // session's state is not this socket's to touch.
        if (closed) return;
        setConnected(false);
        // With the socket shut the spoon cannot be heard, which is not the spoon
        // going quiet. Forget when it last spoke, so nothing downstream reports
        // a spoon fault for what is a server fault.
        lastSampleAt.current = null; dip.current = null;
        pendingLatest.current = null;
        // 4404: the server has no such patient. Asking again every two seconds
        // will not change that.
        if (ev.code === 4404) { setNotFound(true); return; }
        retry = setTimeout(connect, 2000);
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
        latchedInRange.current = pendingSubmerged.current.inRange;
        latchedAt.current = Date.now();
        pendingSubmerged.current = null;
      }
      if (buffer.current.length) {
        const incoming = buffer.current;
        buffer.current = [];
        setPoints((prev) => [...prev, ...incoming].slice(-MAX_POINTS));
      }

      // Liveness rides on this tick rather than a timer of its own, and only
      // reaches React when the answer - or the whole second - changes.
      const now = Date.now();
      const age = lastSampleAt.current === null ? null : now - lastSampleAt.current;
      const live = age !== null && age < SILENT_MS;
      const silentS = age === null ? null : Math.floor(age / 1000);
      if (live !== shownLive.current) { shownLive.current = live; setSpoonLive(live); }
      if (silentS !== shownSilentS.current) { shownSilentS.current = silentS; setSilentForS(silentS); }

      // The latch has an age outside a meal. Nothing there will ever clear it
      // (see LATCH_MAX_AGE_MS), and a refusal from a spoon since switched off,
      // or from a bowl dipped a minute ago, is not a current one.
      if (latchedInRange.current !== null && openMeal.current === null
          && (!live || now - (latchedAt.current ?? 0) > LATCH_MAX_AGE_MS)) {
        setLastSubmergedTempC(null); setLastSubmergedInRange(null);
        latchedInRange.current = null; latchedAt.current = null;
      }

      // A dip that ended and was not answered by a bite was not counted.
      const d = dip.current;
      if (d !== null && d.endedAt !== null && now - d.endedAt > DIP_GRACE_MS) {
        missDip(d.inRange ? 'unsteady' : 'out-of-range');
      }
    }, FLUSH_MS);

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      clearInterval(flush);
      ws?.close();
    };
  }, [patientId]);

  // The reset above runs in an effect, which is after the first render that
  // already has the new patientId - and that render is painted. For that frame
  // the state is still the last patient's: their bowl against this patient's
  // intake, their role="alert" banners on this patient's page. Hand back an
  // empty session until the state is this patient's (useApi does the same).
  if (forPatient !== patientId) return { ...EMPTY, revision, bump };

  return {
    connected, notFound, holder, spoonBusyElsewhere, spoonLive, silentForS,
    latest, points, bites, activeMealId,
    mealTotals, lastError, lastSubmergedTempC, lastSubmergedInRange,
    labelCheck, mealLabel, lastDip, dipsNotCounted, revision, bump,
  };
}
