import { useEffect, useId, useRef, useState } from 'react';
import { ManualMeal } from '../types';
import { errorText, getJson, sendJson } from '../lib/api';
import { fmtMg } from '../lib/sodium';
import { dayAndTime, shortTime } from '../lib/time';

/** Mirrors MANUAL_MAX_MG in backend/app/main.py, which refuses it again. */
const MAX_MG = 5000;
/** One item this large is more often a typo than a food. Asked twice, never refused. */
const CONFIRM_MG = 2000;
const HISTORY = 40;
const MAX_PICKS = 6;
const MAX_EARLIER = 10;
const UNDO_MS = 8000;

interface Props {
  patientId: string;
  onChange: () => void;
  /** This patient's open meal, if the spoon is measuring one. */
  activeMealId: number | null;
  /** The patient's daily limit. Null until it has loaded. */
  targetMg: number | null;
}

interface Pick { name: string; portion: string | null; sodium_mg: number }

/** What just happened, with the way back. */
type Receipt =
  | { kind: 'added'; entry: ManualMeal }
  | { kind: 'removed'; entry: ManualMeal };

/**
 * Picks are the patient's own past entries, not a food database, so they make
 * no new accuracy claim: the milligrams are whatever the patient last read off
 * that label. Ranked by how often, then how recently.
 */
function picksFrom(entries: ManualMeal[]): Pick[] {
  // Entries arrive newest first, so the first seen of a group is its most recent.
  const groups = new Map<string, { pick: Pick; count: number; order: number }>();
  entries.forEach((e, order) => {
    const key = `${e.name.trim().toLowerCase()}|${(e.portion ?? '').trim().toLowerCase()}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, {
      pick: { name: e.name, portion: e.portion, sodium_mg: e.sodium_mg }, count: 1, order,
    });
  });
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, MAX_PICKS)
    .map((g) => g.pick);
}

function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString();
}

/**
 * The spoon only reads liquids. Without this the daily total is blind to bread,
 * crackers, cheese — most of what actually carries dietary sodium.
 *
 * Kept visibly separate from measured bites. Partial monitoring you are honest
 * about beats a total that quietly under-reports.
 *
 * Friction here decides whether any number a clinician sees means anything, so
 * a food logged once is one tap the next time, a slip is one tap to undo, and
 * a typo like 99999 is refused before it becomes the day's total.
 */
export function ManualMealForm({ patientId, onChange, activeMealId, targetMg }: Props) {
  // Null until the first answer: an unloaded log is not an empty one.
  const [entries, setEntries] = useState<ManualMeal[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [portion, setPortion] = useState('');
  const [sodium, setSodium] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The amount the patient has been asked to confirm. Any edit clears it.
  const [confirmMg, setConfirmMg] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const nameId = useId();
  const portionId = useId();
  const sodiumId = useId();
  const hintId = useId();
  const errorId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  // Who is on screen now. An answer about anyone else arrives too late to use:
  // their foods would become this patient's one-tap picks.
  const current = useRef(patientId);
  current.current = patientId;

  async function refresh() {
    const asked = patientId;
    try {
      const list = await getJson<ManualMeal[]>(
        `/api/manual-meals?limit=${HISTORY}&patientId=${asked}`);
      if (current.current !== asked) return;
      setEntries(list);
      setLoadError(false);
    } catch {
      if (current.current === asked) setLoadError(true);
    }
  }

  useEffect(() => {
    setEntries(null); setLoadError(false); setReceipt(null);
    setError(null); setConfirmMg(null); setBusy(false);
    refresh();
  }, [patientId]);

  // The rest of the page polls its way back after an outage; so does this.
  useEffect(() => {
    if (!loadError) return;
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [loadError, patientId]);

  // The way back is offered for a moment, not for ever.
  useEffect(() => {
    if (receipt === null) return;
    const timer = setTimeout(() => setReceipt(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [receipt]);

  /** Every write goes through here: one in flight at a time, then the list and
   *  the day's total catch up. */
  async function write(action: () => Promise<Receipt | null>) {
    const asked = patientId;
    setBusy(true);
    setError(null);
    try {
      const done = await action();
      // The write stands, but its receipt and its Undo belong to the patient
      // it was made for, who is no longer the one on screen.
      if (current.current !== asked) return false;
      setReceipt(done);
      await refresh();
      onChange();
      return true;
    } catch (e) {
      if (current.current !== asked) return false;
      setReceipt(null);
      setError(errorText(e));
      return false;
    } finally {
      if (current.current === asked) setBusy(false);
    }
  }

  // `restore` is Undo's: the original time and tag, so a seeded row put back is
  // still a seeded row and keeps its day.
  const post = (p: Pick, restore?: ManualMeal) => sendJson<ManualMeal>('POST', '/api/manual-meals', {
    name: p.name, portion: p.portion, sodium_mg: p.sodium_mg, patientId,
    ts_utc: restore?.ts_utc, source: restore ? (restore.source === 'seed' ? 'seed' : 'manual') : undefined,
  });
  const del = (id: number) =>
    sendJson('DELETE', `/api/manual-meals/${id}?patientId=${patientId}`);

  const logAgain = (p: Pick) => write(async () => ({ kind: 'added', entry: await post(p) }));

  const remove = (entry: ManualMeal) => write(async () => {
    await del(entry.id);
    return { kind: 'removed', entry };
  });

  const undo = (r: Receipt) => write(async () => {
    // A restored entry keeps its original time, and so its original day.
    if (r.kind === 'removed') await post(r.entry, r.entry);
    else await del(r.entry.id);
    return null;
  });

  function edit(set: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      set(e.target.value);
      setConfirmMg(null);
      setError(null);
    };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    // "1,800" is how the label prints it.
    const typed = sodium.replace(/[,\s]/g, '');
    const mg = /^\d+(\.\d+)?$/.test(typed) ? Number(typed) : NaN;
    if (!name.trim()) { nameRef.current?.focus(); return setError('Say what the food was.'); }
    if (!Number.isFinite(mg) || mg < 0 || mg > MAX_MG)
      return setError(`Sodium must be between 0 and ${fmtMg(MAX_MG)} mg for one item.`);
    if (mg >= CONFIRM_MG && confirmMg !== mg) {
      setError(null);
      return setConfirmMg(mg);
    }

    const saved = await write(async () => ({
      kind: 'added',
      entry: await post({ name: name.trim(), portion: portion.trim() || null, sodium_mg: mg }),
    }));
    if (saved) {
      setName(''); setPortion(''); setSodium(''); setConfirmMg(null);
    }
  }

  const picks = picksFrom(entries ?? []);
  const today = (entries ?? []).filter((e) => isToday(e.ts_utc));
  const earlier = (entries ?? []).filter((e) => !isToday(e.ts_utc));

  const row = (e: ManualMeal, when: string) => (
    <li key={e.id}>
      <div className="entry-main">
        <span><strong>{e.name}</strong>{e.portion && ` · ${e.portion}`}</span>
        <span className="entry-mg">{fmtMg(e.sodium_mg)} mg</span>
      </div>
      <div className="entry-meta">
        <span>{when}</span>
        <button type="button" className="btn-link" onClick={() => remove(e)} disabled={busy}
                aria-label={`Remove ${e.name}, ${fmtMg(e.sodium_mg)} milligrams`}>remove</button>
      </div>
    </li>
  );

  return (
    <section className="card">
      <h2>Log solid food</h2>
      <p className="cap">
        Self-reported · the probe reads liquids only, so solids are entered by hand
      </p>

      {picks.length > 0 && (
        <div className="picks" role="group" aria-label="Log again">
          <span className="picks-label">Log again</span>
          <div className="pill-row">
            {picks.map((p) => (
              <button key={`${p.name}|${p.portion ?? ''}`} type="button" className="pill pill-btn pick"
                      disabled={busy} onClick={() => logAgain(p)}
                      aria-label={`Log ${p.name}${p.portion ? `, ${p.portion}` : ''}, ${fmtMg(p.sodium_mg)} milligrams again`}>
                {p.name}{p.portion && ` · ${p.portion}`} · {fmtMg(p.sodium_mg)} mg
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={submit} noValidate>
        <div className="form-row form-row-labelled form-row-top">
          <div className="field-group field-group-wide">
            <label htmlFor={nameId}>Food</label>
            <input id={nameId} ref={nameRef} className="field" maxLength={80} autoComplete="off"
                   placeholder="e.g. whole wheat bread"
                   value={name} onChange={edit(setName)} />
          </div>
          <div className="field-group">
            <label htmlFor={portionId}>How much (optional)</label>
            <input id={portionId} className="field" maxLength={40} autoComplete="off"
                   placeholder="e.g. 2 slices"
                   value={portion} onChange={edit(setPortion)} />
          </div>
          <div className="field-group">
            <label htmlFor={sodiumId}>Sodium (mg)</label>
            <input id={sodiumId} className="field" inputMode="numeric" autoComplete="off"
                   aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
                   value={sodium} onChange={edit(setSodium)} />
            <span id={hintId} className="field-hint">from the Nutrition Facts label</span>
          </div>
        </div>
        <div className="form-row" style={{ marginTop: 10 }}>
          <button className="btn" type="submit" disabled={busy}>
            {confirmMg !== null ? `Add ${fmtMg(confirmMg)} mg` : busy ? 'Saving…' : 'Add'}
          </button>
        </div>
      </form>
      {confirmMg !== null && (
        <p className="form-note" role="alert">
          {fmtMg(confirmMg)} mg is{' '}
          {targetMg ? `${Math.round((confirmMg / targetMg) * 100)}% of your daily limit` : 'a lot'}{' '}
          for one item. If the label really says that, press Add again.
        </p>
      )}
      {error && <p id={errorId} className="form-note" role="alert">{error}</p>}
      {activeMealId !== null && (
        // PLAN.md §7: the same food counted by the spoon and by hand is counted twice.
        <p className="form-note">
          The spoon is measuring this meal. Only add food the spoon did not touch.
        </p>
      )}

      {/* Always mounted, so the live region exists before it has something to say. */}
      <p className="form-note receipt" role="status">
        {receipt && (
          <>
            {receipt.kind === 'added' ? 'Added' : 'Removed'} {receipt.entry.name}
            {' '}· {fmtMg(receipt.entry.sodium_mg)} mg ·{' '}
            <button type="button" className="btn-link" disabled={busy}
                    onClick={() => undo(receipt)}>Undo</button>
          </>
        )}
      </p>

      <div className="rule" />
      <h3 className="sub-head">Logged today</h3>
      {entries === null ? (
        loadError ? (
          <p className="empty" role="status">
            Can't load your food log right now.{' '}
            <button type="button" className="btn-link" onClick={refresh}>Try again</button>
          </p>
        ) : <p className="empty">Loading your food log…</p>
      ) : (
        <>
          {today.length === 0
            ? <p className="empty">Nothing self-reported today.</p>
            : <ul className="entry-list">{today.map((e) => row(e, shortTime(e.ts_utc)))}</ul>}
          {loadError && (
            <p className="form-note" role="status">
              Couldn't refresh. This is the last list received.
            </p>
          )}
          {earlier.length > 0 && (
            <details className="earlier">
              {/* At the fetch limit the count is the limit's, not the log's. */}
              <summary>
                Earlier entries{(entries.length < HISTORY) && ` (${earlier.length})`}
              </summary>
              <ul className="entry-list">
                {earlier.slice(0, MAX_EARLIER).map((e) => row(e, dayAndTime(e.ts_utc)))}
              </ul>
              {earlier.length > MAX_EARLIER && (
                <p className="note fine">Showing the latest {MAX_EARLIER}.</p>
              )}
            </details>
          )}
        </>
      )}
    </section>
  );
}
