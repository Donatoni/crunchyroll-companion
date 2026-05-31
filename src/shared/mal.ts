/**
 * Minimal MyAnimeList API v2 client.
 *
 * MAL uses OAuth2 authorization-code + PKCE. Public clients (app type "other")
 * need no client secret. We use code_challenge_method=plain (challenge ==
 * verifier), which MAL supports. All requests are made from contexts that hold
 * host_permissions for *.myanimelist.net, so CORS does not apply.
 */
import { MAL_CLIENT_ID } from './mal-config';

const AUTHORIZE = 'https://myanimelist.net/v1/oauth2/authorize';
const TOKEN = 'https://myanimelist.net/v1/oauth2/token';
const API = 'https://api.myanimelist.net/v2';

export interface MalToken {
  access: string;
  refresh: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface MalAnime {
  id: number;
  title: string;
  episodes: number | null;
}

/** PKCE verifier: 43–128 chars from the unreserved set. */
export function randomVerifier(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function authorizeUrl(
  codeChallenge: string,
  redirectUri: string,
  state: string,
): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: MAL_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'plain',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE}?${p.toString()}`;
}

async function postToken(body: URLSearchParams): Promise<MalToken> {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`MAL token HTTP ${res.status}`);
  const j = await res.json();
  return {
    access: j.access_token,
    refresh: j.refresh_token,
    expiresAt: Date.now() + Number(j.expires_in) * 1000,
  };
}

export function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<MalToken> {
  return postToken(
    new URLSearchParams({
      client_id: MAL_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  );
}

export async function refresh(refreshToken: string): Promise<MalToken> {
  const t = await postToken(
    new URLSearchParams({
      client_id: MAL_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
  // MAL may omit a new refresh token; keep the old one if so.
  return { ...t, refresh: t.refresh || refreshToken };
}

export async function getUserName(access: string): Promise<string> {
  const res = await fetch(`${API}/users/@me?fields=name`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
  return (await res.json()).name;
}

export async function searchAnime(access: string, q: string): Promise<MalAnime[]> {
  const res = await fetch(
    `${API}/anime?q=${encodeURIComponent(q)}&limit=10&fields=num_episodes`,
    { headers: { Authorization: `Bearer ${access}` } },
  );
  if (!res.ok) throw new Error(`MAL search HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map((d: { node: { id: number; title: string; num_episodes?: number } }) => ({
    id: d.node.id,
    title: d.node.title,
    episodes: d.node.num_episodes || null,
  }));
}

export async function updateProgress(
  access: string,
  animeId: number,
  episodes: number,
  completed: boolean,
): Promise<void> {
  const res = await fetch(`${API}/anime/${animeId}/my_list_status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      num_watched_episodes: String(episodes),
      status: completed ? 'completed' : 'watching',
    }),
  });
  if (!res.ok) throw new Error(`MAL update HTTP ${res.status}`);
}
