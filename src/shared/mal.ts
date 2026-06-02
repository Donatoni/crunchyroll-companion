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

/**
 * Auth header for a MAL API call. With a user access token we send a Bearer
 * token (gives access to the user's list); without one we fall back to the
 * `X-MAL-CLIENT-ID` header, which MAL accepts for PUBLIC data (search + anime
 * details) — so we can show show info even when the user isn't signed in.
 */
function authHeaders(access: string | null): Record<string, string> {
  return access
    ? { Authorization: `Bearer ${access}` }
    : { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID };
}

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
  /** MAL media type: tv, movie, ova, ona, special, music. */
  mediaType: string | null;
  /** English / Japanese / synonym titles, for fuzzy matching. */
  altTitles: string[];
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

interface MalAnimeNode {
  id: number;
  title: string;
  num_episodes?: number;
  media_type?: string;
  alternative_titles?: { en?: string; ja?: string; synonyms?: string[] };
}

export async function searchAnime(access: string | null, q: string): Promise<MalAnime[]> {
  const res = await fetch(
    `${API}/anime?q=${encodeURIComponent(q)}&limit=10&fields=num_episodes,media_type,alternative_titles`,
    { headers: authHeaders(access) },
  );
  if (!res.ok) throw new Error(`MAL search HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map((d: { node: MalAnimeNode }) => ({
    id: d.node.id,
    title: d.node.title,
    episodes: d.node.num_episodes || null,
    mediaType: d.node.media_type ?? null,
    altTitles: [
      d.node.alternative_titles?.en,
      d.node.alternative_titles?.ja,
      ...(d.node.alternative_titles?.synonyms ?? []),
    ].filter((t): t is string => !!t),
  }));
}

export interface MalStatus {
  /** Total episodes in the anime, if known. */
  total: number | null;
  /** Community mean score, if any. */
  mean: number | null;
  /** The user's list status (watching/completed/…) or null if not on their list. */
  status: string | null;
  /** The user's score (1–10), or null/0 if unrated. */
  score: number | null;
  /** Episodes the user has marked watched. */
  watched: number;
  /** Whether the user is currently rewatching. */
  rewatching: boolean;
  /** How many times the user has rewatched it. */
  rewatchCount: number;
}

/** Fetch the anime's totals plus the signed-in user's list entry for it. */
export async function getAnimeStatus(
  access: string,
  animeId: number,
): Promise<MalStatus> {
  const res = await fetch(
    `${API}/anime/${animeId}?fields=num_episodes,mean,my_list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched}`,
    { headers: { Authorization: `Bearer ${access}` }, cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
  const j = await res.json();
  const m = j.my_list_status;
  return {
    total: j.num_episodes || null,
    mean: j.mean ?? null,
    status: m?.status ?? null,
    score: m?.score || null,
    watched: m?.num_episodes_watched ?? 0,
    rewatching: !!m?.is_rewatching,
    rewatchCount: m?.num_times_rewatched ?? 0,
  };
}

export interface MalRelated {
  id: number;
  title: string;
  picture: string | null;
  mediaType: string | null;
  episodes: number | null;
  relation: string;
}

export interface MalCharacter {
  name: string;
  image: string | null;
  role: string;
}

export interface MalDetails extends MalStatus {
  title: string;
  synopsis: string;
  /** Poster image (MAL main_picture). */
  picture: string | null;
  genres: string[];
  rank: number | null;
  mediaType: string | null;
  year: number | null;
  studios: string[];
  related: MalRelated[];
}

/**
 * Fetch rich show details (and the user's list entry, if signed in) in one call.
 * Works without a token via the client-id header — the `my_list_status` field is
 * only requested when there's a user token (it's meaningless otherwise).
 */
export async function getAnimeDetails(
  access: string | null,
  animeId: number,
): Promise<MalDetails> {
  const fields =
    'title,synopsis,main_picture,genres,mean,rank,num_episodes,media_type,start_season,studios,' +
    'related_anime{media_type,num_episodes,main_picture}' +
    (access ? ',my_list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched}' : '');
  const res = await fetch(`${API}/anime/${animeId}?fields=${fields}`, {
    headers: authHeaders(access),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
  const j = await res.json();
  const m = j.my_list_status;
  return {
    title: j.title ?? '',
    synopsis: j.synopsis ?? '',
    picture: j.main_picture?.large ?? j.main_picture?.medium ?? null,
    genres: (j.genres ?? []).map((g: { name: string }) => g.name),
    mean: j.mean ?? null,
    rank: j.rank ?? null,
    total: j.num_episodes || null,
    mediaType: j.media_type ?? null,
    year: j.start_season?.year ?? null,
    studios: (j.studios ?? []).map((s: { name: string }) => s.name),
    related: (j.related_anime ?? []).map(
      (r: {
        node: { id: number; title: string; main_picture?: { medium?: string }; media_type?: string; num_episodes?: number };
        relation_type_formatted?: string;
        relation_type?: string;
      }) => ({
        id: r.node.id,
        title: r.node.title,
        picture: r.node.main_picture?.medium ?? null,
        mediaType: r.node.media_type ?? null,
        episodes: r.node.num_episodes || null,
        relation: r.relation_type_formatted ?? r.relation_type ?? '',
      }),
    ),
    status: m?.status ?? null,
    score: m?.score || null,
    watched: m?.num_episodes_watched ?? 0,
    rewatching: !!m?.is_rewatching,
    rewatchCount: m?.num_times_rewatched ?? 0,
  };
}

/**
 * Characters for an anime via the unofficial Jikan API (MAL's own v2 API has no
 * character endpoint). Jikan keys by MAL id, so the same id works. Best-effort —
 * callers should tolerate this throwing / returning [].
 */
export async function getCharacters(animeId: number): Promise<MalCharacter[]> {
  const res = await fetch(`https://api.jikan.moe/v4/anime/${animeId}/characters`);
  if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? [])
    .slice(0, 14)
    .map((d: { character?: { name?: string; images?: { jpg?: { image_url?: string } } }; role?: string }) => ({
      name: d.character?.name ?? '',
      image: d.character?.images?.jpg?.image_url ?? null,
      role: d.role ?? '',
    }));
}

export interface MalListPatch {
  num_watched_episodes?: number;
  status?: string;
  /** 1–10, or 0 to clear the score. */
  score?: number;
  is_rewatching?: boolean;
  num_times_rewatched?: number;
}

/** Patch the signed-in user's list entry (any subset of fields). */
export async function setMyListStatus(
  access: string,
  animeId: number,
  patch: MalListPatch,
): Promise<void> {
  const body = new URLSearchParams();
  if (patch.num_watched_episodes != null)
    body.set('num_watched_episodes', String(patch.num_watched_episodes));
  if (patch.status) body.set('status', patch.status);
  if (patch.score != null) body.set('score', String(patch.score));
  if (patch.is_rewatching != null)
    body.set('is_rewatching', String(patch.is_rewatching));
  if (patch.num_times_rewatched != null)
    body.set('num_times_rewatched', String(patch.num_times_rewatched));
  const res = await fetch(`${API}/anime/${animeId}/my_list_status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail}`.trim().slice(0, 180));
  }
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
