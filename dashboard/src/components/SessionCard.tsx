import { useEffect, useId, useRef, useState } from 'react';
import { LabelClaimOption } from '../types';
import { ApiError, errorText, getJson, sendJson } from '../lib/api';
import * as sev from '../lib/severity';

interface Props {
  patientId: string;
  /** The open meal, if it is this patient's. */
  activeMealId: number | null;
  /** What has been declared for the open meal. Null when no meal is open. */
  mealLabel: { product_name: string | null; label_claim: string } | null;
  /** True when someone else is mid-meal with the spoon. */
  spoonBusyElsewhere: boolean;
  /** The session socket is open: the server can be reached. */
  connected: boolean;
  /** This patient holds the spoon. */
  holder: boolean;
  /** A sample arrived in the last few seconds. */
  spoonLive: boolean;
  /** Whole seconds since the last sample in this session; null if none. */
  silentForS: number | null;
  /** Any spoon sent anything to the server lately. Null while unknown. */
  spoonOnline: boolean | null;
  onChange: () => void;
}

/**
 * Starting and ending a meal.
 *
 * The spoon still opens a meal by itself on the first bite - nobody should have
 * to press a button to eat. Starting one here does two things that path cannot:
 * it puts the meal against the right patient, and it lets the label be declared
 * up front, so the label check runs from the first bite instead of from
 * whenever someone remembers.
 *
 * This card is the only place a label is declared: up front when starting, or
 * with "Change" once the meal is open. It used to be declarable from a second
 * card as well, whose inputs went stale and whose Apply was dead on Live.
 *
 * It is also where a patient finds out why nothing is happening. "The server
 * cannot be reached", "the spoon has gone quiet", "no spoon is on" and "someone
 * else has it" are four different problems with four different remedies.
 */
export function SessionCard({
  patientId, activeMealId, mealLabel, spoonBusyElsewhere, connected, holder, spoonLive,
  silentForS, spoonOnline, onChange,
}: Props) {
  // Null: the claims could not be loaded, so the select is not offered at all.
  const [claims, setClaims] = useState<LabelClaimOption[] | null>(null);
  const [product, setProduct] = useState('');
  const [claim, setClaim] = useState('none');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The in-meal label editor. Closed, the line above it states the label.
  const [editing, setEditing] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const editProductRef = useRef<HTMLInputElement>(null);
  // A session takes a moment to open. Until it has had one, "not connected
  // yet" is not "can't reach the server", and saying so would flash on every load.
  const [settled, setSettled] = useState(false);
  const productId = useId();
  const claimId = useId();

  useEffect(() => {
    let stale = false;
    getJson<{ claims: LabelClaimOption[] }>('/api/label-claims')
      .then((d) => { if (!stale) setClaims(d.claims.length ? d.claims : null); })
      .catch(() => { if (!stale) setClaims(null); });
    return () => { stale = true; };
    // Asked again when the server comes back, or the select would stay hidden.
  }, [connected]);

  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), 1500);
    return () => clearTimeout(timer);
  }, [patientId]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setNote(null);
    try {
      await action();
      onChange();
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(async () => {
    await sendJson('POST', '/api/meals/start', {
      patientId,
      product_name: product.trim() || null,
      label_claim: claims ? claim : 'none',
    });
    setProduct('');
    setClaim('none');
  });

  const end = () => run(() => sendJson('POST', '/api/meals/close', { patientId }));

  function openEditor() {
    setProduct(mealLabel?.product_name ?? '');
    setClaim(mealLabel?.label_claim ?? 'none');
    setNote(null);
    setEditing(true);
  }

  function closeEditor() {
    setEditing(false);
    setProduct('');
    setClaim('none');
  }

  // Focus follows the editor: into the first field when it opens, back to the
  // button that opened it when it closes, so a keyboard user is never dropped.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) editProductRef.current?.focus();
    else if (wasEditing.current) changeRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  // A meal that ends, or a change of patient, takes the editor with it.
  // So do the fields the editor shares with the start form: the last bowl's
  // label must not be waiting, pre-filled, to be declared on the next one.
  useEffect(() => {
    setEditing(false); setProduct(''); setClaim('none'); setNote(null);
  }, [activeMealId, patientId]);

  async function saveLabel() {
    setBusy(true);
    setNote(null);
    try {
      await sendJson('POST', '/api/meals/label', {
        patientId,
        product_name: product.trim() || null,
        // Without the list of claims the select is not shown; keep what was declared.
        label_claim: claims ? claim : mealLabel?.label_claim ?? 'none',
      });
      // The new label arrives through the session's spoon announce.
      closeEditor();
      onChange();
    } catch (e) {
      // The other 409 - the spoon is in someone else's meal - is said as sent.
      setNote(e instanceof ApiError && e.status === 409 && /^no meal/i.test(e.message)
        ? 'There is no meal in progress to label.'
        : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Only a spoon the server can hear can be called silent.
  const silent = connected && !spoonLive && silentForS !== null;
  const unreachable = !connected && settled;

  if (activeMealId !== null) {
    return (
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Meal in progress</h2>
            <p className="cap" style={{ margin: 0 }}>
              Every dip is logged to you. It also ends by itself after 20 minutes
              without a bite.
            </p>
          </div>
          <button className="btn btn-quiet" onClick={end} disabled={busy || !connected}>
            {busy ? 'Ending…' : 'End meal'}
          </button>
        </div>
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); if (!busy) saveLabel(); }}
                onKeyDown={(e) => { if (e.key === 'Escape') closeEditor(); }}>
            <div className="form-row form-row-labelled" style={{ marginTop: 12 }}>
              <div className="field-group">
                <label htmlFor={productId}>What are you eating? (optional)</label>
                <input id={productId} ref={editProductRef} className="field"
                       placeholder="e.g. chicken broth" maxLength={80}
                       value={product} onChange={(e) => setProduct(e.target.value)} />
              </div>
              {claims && (
                <div className="field-group">
                  <label htmlFor={claimId}>Sodium claim on the label</label>
                  <select id={claimId} className="field" value={claim}
                          onChange={(e) => setClaim(e.target.value)}>
                    {claims.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.value === 'none' ? 'No sodium claim on label' : `Label says: ${c.label.toLowerCase()}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <button className="btn" type="submit" disabled={busy || !connected}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-quiet" type="button" onClick={closeEditor} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <p className="note label-line">
            {mealLabel && (mealLabel.product_name || mealLabel.label_claim !== 'none') ? (
              <>
                <strong>{mealLabel.product_name ?? 'Not named'}</strong>
                {mealLabel.label_claim !== 'none'
                  && ` · labelled ${claimText(claims, mealLabel.label_claim)}`}
              </>
            ) : (
              <span className="muted">You have not said what is in the bowl.</span>
            )}{' '}
            <button ref={changeRef} type="button" className="btn-link" onClick={openEditor}>
              {mealLabel && (mealLabel.product_name || mealLabel.label_claim !== 'none')
                ? 'Change' : 'Say what it is'}
            </button>
          </p>
        )}
        {/* A spoon gone quiet mid-meal is said once, by the banner at the top of
            the page (SpoonSilentBanner), and not again here. */}
        {unreachable && (
          <p className="form-note" role="status">
            Can't reach the server right now. The meal is still open; this page
            catches up once it is back.
          </p>
        )}
        {note && <p className="form-note" role="status">{note}</p>}
      </section>
    );
  }

  // One reason at a time, the one that most decides what to do next.
  const why = spoonBusyElsewhere
    ? "The spoon is in the middle of another patient's meal. It frees up when that meal ends."
    : unreachable
      ? "Can't reach the server right now. Starting a meal works again once it is back."
      : holder && silent
        ? `The spoon has not sent anything for ${sev.silentFor(silentForS ?? 0)}. Check it is `
          + 'switched on. You can still start the meal; bites appear once it is back.'
        : spoonOnline === false
          ? 'No spoon is switched on yet. You can start the meal; bites appear once it connects.'
          : null;

  // No form while it could not be used. A dip now would be logged to the other
  // patient, so this card must not invite one; it returns when the spoon frees
  // up or the server is back, which the session announces.
  if (spoonBusyElsewhere || unreachable) {
    return (
      <section className="card">
        <h2>Start a meal</h2>
        <p className="form-note" role="status" style={{ marginTop: 0 }}>{why}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Start a meal</h2>
      <p className="cap">
        Say what is in the bowl and its label is checked from the first bite. Optional —
        dipping the spoon starts a meal too.
      </p>
      <div className="form-row form-row-labelled">
        <div className="field-group">
          <label htmlFor={productId}>What are you eating? (optional)</label>
          <input id={productId} className="field" placeholder="e.g. chicken broth"
                 value={product} onChange={(e) => setProduct(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter' && !busy && !spoonBusyElsewhere && connected) start();
                 }} />
        </div>
        {claims && (
          <div className="field-group">
            <label htmlFor={claimId}>Sodium claim on the label</label>
            <select id={claimId} className="field" value={claim}
                    onChange={(e) => setClaim(e.target.value)}>
              {claims.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.value === 'none' ? 'No sodium claim on label' : `Label says: ${c.label.toLowerCase()}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <button className="btn" onClick={start}
                disabled={busy || spoonBusyElsewhere || !connected}>
          {busy ? 'Starting…' : 'Start meal'}
        </button>
      </div>
      {why && <p className="form-note" role="status">{why}</p>}
      {note && <p className="form-note" role="status">{note}</p>}
    </section>
  );
}

/** A claim's value as the label words it. Falls back to the value, de-snaked,
 *  when the list of claims could not be loaded. */
function claimText(claims: LabelClaimOption[] | null, value: string): string {
  const known = claims?.find((c) => c.value === value);
  return (known ? known.label : value.replace(/_/g, ' ')).toLowerCase();
}
