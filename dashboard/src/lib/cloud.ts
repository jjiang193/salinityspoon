/**
 * Where this build talks to, and who it says it is.
 *
 * Two deployments, one build system. With no `VITE_API_BASE` the dashboard is
 * origin-relative and talks to the local backend through Vite's proxy, exactly
 * as it always has — that is the demo path, and nothing below runs. Given one,
 * it talks to AWS and every request carries a Cognito id token.
 *
 * The token is held in memory only. It is not PHI, but it opens PHI, and the
 * reference sheet's rule for anything in that family is that it does not go in
 * localStorage. The cost is signing in again after a reload, which is the right
 * trade for a clinician's laptop on a ward.
 */

export const API_BASE = import.meta.env.VITE_API_BASE ?? '';
export const WS_BASE = import.meta.env.VITE_WS_BASE ?? '';
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID ?? '';
const REGION = import.meta.env.VITE_COGNITO_REGION ?? 'us-east-1';

/** True when this build reads from AWS and therefore needs a sign-in. */
export const cloudMode = Boolean(API_BASE && CLIENT_ID);

/**
 * The token survives a reload for SESSION_MINUTES, in sessionStorage - which is
 * per tab and dies with it. Not localStorage: that outlives the tab, syncs
 * across windows, and is the thing the security notes say to keep PHI-adjacent
 * material out of. The short life is the point: a clinician's laptop left open
 * on a ward asks again rather than staying signed in all afternoon.
 */
const SESSION_MINUTES = 5;
const STORE_KEY = 'natrack.session';

let idToken: string | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

function remember(token: string): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({
      token, expiresAt: Date.now() + SESSION_MINUTES * 60_000,
    }));
  } catch {
    // Private browsing, or storage turned off. The session then lasts exactly
    // as long as the page does, which is a worse experience and not a bug.
  }
}

function restore(): string | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (typeof token !== 'string' || typeof expiresAt !== 'number' || Date.now() > expiresAt) {
      sessionStorage.removeItem(STORE_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

idToken = restore();

/** What the token says about the signed-in person. Read, never trusted: the
 *  API checks all of this again, and it is only used to decide what to show. */
function claims(): Record<string, unknown> {
  if (!idToken) return {};
  try {
    const part = idToken.split('.')[1];
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

export type Role = 'clinician' | 'patient' | null;

export function role(): Role {
  const groups = claims()['cognito:groups'];
  const list = Array.isArray(groups) ? groups : [];
  if (list.includes('clinician')) return 'clinician';
  if (list.includes('patient')) return 'patient';
  return null;
}

/** A patient's own id, from their token. The API takes it from there too. */
export function ownPatientId(): string | null {
  const id = claims()['custom:patientId'];
  return typeof id === 'string' ? id : null;
}

export function signedInAs(): string | null {
  const email = claims().email;
  return typeof email === 'string' ? email : null;
}

export function signedIn(): boolean {
  return !cloudMode || idToken !== null;
}

export function onAuthChange(fn: (signedIn: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(): void {
  listeners.forEach((fn) => fn(signedIn()));
}

/** The header every request carries in cloud mode, and nothing in local mode. */
export function authHeaders(): Record<string, string> {
  return idToken ? { Authorization: `Bearer ${idToken}` } : {};
}

export function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path;
}

export function sessionUrl(patientId: string): string {
  if (WS_BASE) return `${WS_BASE}?patientId=${encodeURIComponent(patientId)}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/session/${patientId}`;
}

/**
 * Sign in against Cognito directly. No SDK: this is one JSON call, and a
 * dependency that ships a megabyte of crypto to do it is a dependency that has
 * to be reviewed.
 */
export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  }).catch(() => { throw new Error("Can't reach the sign-in service"); });

  if (!res.ok) {
    // Cognito's own words are accurate but shaped for a developer. One sentence
    // a person can act on, and never "no such user" — which would say out loud
    // which addresses have accounts.
    throw new Error('That email and password did not match.');
  }

  const body = await res.json();
  const token = body?.AuthenticationResult?.IdToken;
  if (!token) throw new Error('Sign-in needs another step that this page cannot do yet.');
  idToken = token;
  remember(token);
  announce();
}

export function signOut(): void {
  idToken = null;
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* see remember() */ }
  announce();
}
