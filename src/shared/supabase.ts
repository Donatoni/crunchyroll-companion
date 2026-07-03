/**
 * Minimal Supabase client (auth + PostgREST) over `fetch` — no SDK, to keep the
 * bundle small and match the rest of the codebase.
 *
 * Auth is Google OAuth via Supabase's PKCE flow: we open
 * `/auth/v1/authorize?provider=google&code_challenge=…` in launchWebAuthFlow
 * (run from a UI page, never the service worker — same constraint as the MAL
 * flow), get an auth code back in the redirect query, and exchange it (with the
 * verifier) at `/auth/v1/token?grant_type=pkce`. PKCE keeps tokens out of URLs
 * entirely, unlike the implicit flow this replaces. The session is kept in
 * storage.local and used as a Bearer token for REST calls, which RLS scopes to
 * the signed-in user.
 */
import { randomVerifier, s256Challenge } from './pkce';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './supabase-config';

const SESSION_KEY = 'sb_session';

export interface SbSession {
  access: string;
  refresh: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  userId: string;
  email: string;
}

// ── session storage ───────────────────────────────────────────────────
export async function getSession(): Promise<SbSession | null> {
  const r = await chrome.storage.local.get(SESSION_KEY);
  return (r[SESSION_KEY] as SbSession | undefined) ?? null;
}
async function setSession(s: SbSession): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: s });
}
export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(SESSION_KEY);
}

// ── helpers ───────────────────────────────────────────────────────────
/** Decode a JWT payload (no verification — we only read our own session). */
function decodeJwt(token: string): { sub?: string; email?: string; exp?: number } {
  try {
    const part = token.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    // Handle any UTF-8 in the payload (e.g. names) rather than raw atob bytes.
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return {};
  }
}

function sessionFromTokens(access: string, refresh: string, expiresIn: number): SbSession {
  const claims = decodeJwt(access);
  return {
    access,
    refresh,
    expiresAt: Date.now() + (expiresIn || 3600) * 1000,
    userId: claims.sub ?? '',
    email: claims.email ?? '',
  };
}

// ── sign in / out ─────────────────────────────────────────────────────
/**
 * Google sign-in. MUST be called from a UI page (the side panel); the MV3
 * worker has no window to host the auth popup. Persists and returns the session.
 */
export async function signInWithGoogle(): Promise<SbSession> {
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = randomVerifier();
  const challenge = await s256Challenge(verifier);
  const url =
    `${SUPABASE_URL}/auth/v1/authorize?provider=google` +
    `&redirect_to=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${challenge}&code_challenge_method=s256`;

  const responseUrl = await new Promise<string | undefined>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (u) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve(u);
    });
  });

  // PKCE returns an auth code in the redirect query string.
  const q = new URLSearchParams((responseUrl ?? '').split('?')[1]?.split('#')[0] ?? '');
  const code = q.get('code');
  if (!code) {
    throw new Error(q.get('error_description') || q.get('error') || 'No auth code returned');
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Token exchange HTTP ${res.status} ${detail}`.trim().slice(0, 180));
  }
  const j = await res.json();
  if (!j.access_token || !j.refresh_token) throw new Error('No token returned');
  const session = sessionFromTokens(
    j.access_token,
    j.refresh_token,
    Number(j.expires_in) || 3600,
  );
  await setSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  const session = await getSession();
  if (session) {
    // Best-effort server-side revoke; the local session is what actually matters.
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access}` },
    }).catch(() => {});
  }
  await clearSession();
}

/** Return a valid access token, refreshing (and re-storing) it if near expiry. */
export async function validAccessToken(): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  if (Date.now() < session.expiresAt - 60_000) return session.access;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh }),
    });
    if (!res.ok) throw new Error(`refresh HTTP ${res.status}`);
    const j = await res.json();
    const fresh = sessionFromTokens(
      j.access_token,
      j.refresh_token || session.refresh,
      Number(j.expires_in) || 3600,
    );
    await setSession(fresh);
    return fresh.access;
  } catch {
    // Refresh token dead (revoked/expired) — drop the session so the UI shows
    // "signed out" instead of silently failing every sync.
    await clearSession();
    return null;
  }
}

// ── REST (PostgREST) ──────────────────────────────────────────────────
export interface RemoteBlob {
  data: unknown;
  updatedAt: string;
}

/** Fetch this user's row for a kind, or null if none exists yet. */
export async function getBlob(kind: string): Promise<RemoteBlob | null> {
  const access = await validAccessToken();
  if (!access) return null;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_blobs?select=data,updated_at&kind=eq.${encodeURIComponent(kind)}`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access}` }, cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`Supabase GET ${kind} HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ data: unknown; updated_at: string }>;
  const row = rows[0];
  return row ? { data: row.data, updatedAt: row.updated_at } : null;
}

/** Upsert this user's row for a kind (conflict on the user_id+kind primary key). */
export async function upsertBlob(kind: string, data: unknown): Promise<void> {
  const access = await validAccessToken();
  const session = await getSession();
  if (!access || !session) throw new Error('Not signed in');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_blobs?on_conflict=user_id,kind`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${access}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([
        { user_id: session.userId, kind, data, updated_at: new Date().toISOString() },
      ]),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase upsert ${kind} HTTP ${res.status} ${detail}`.trim().slice(0, 180));
  }
}
