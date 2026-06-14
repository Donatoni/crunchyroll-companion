/**
 * Minimal MyAnimeList API v2 client.
 *
 * MAL uses OAuth2 authorization-code + PKCE. Public clients (app type "other")
 * need no client secret. We use code_challenge_method=S256 (challenge ==
 * base64url(SHA-256(verifier))) for interception protection. All requests are
 * made from contexts that hold host_permissions for *.myanimelist.net, so CORS
 * does not apply.
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
  // 64-char alphabet so a byte maps to a character with no modulo bias.
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b & 63]).join('');
}

/** base64url (no padding) of raw bytes. */
function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256 code challenge: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
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
    code_challenge_method: 'S256',
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
  // MAL always returns expires_in (seconds); default to 1h if it's ever absent
  // so a NaN expiry doesn't force a refresh on every call.
  const expiresIn = Number(j.expires_in) || 3600;
  return {
    access: j.access_token,
    refresh: j.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
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

export interface MalReview {
  user: string;
  avatar: string | null;
  score: number | null;
  text: string;
  /** "Recommended" / "Mixed Feelings" / "Not Recommended", if any. */
  tag: string;
  /** Link to the full review on MAL. */
  url: string;
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

/**
 * Featured reviews via Jikan (MAL's own API has no reviews endpoint), plus the
 * URL of the show's full reviews tab. That URL needs MAL's title slug, which we
 * get from Jikan's anime endpoint (`data.url`); falls back to the bare anime
 * page if that lookup fails.
 */
export async function getReviews(
  animeId: number,
): Promise<{ reviews: MalReview[]; allUrl: string }> {
  const res = await fetch(
    `https://api.jikan.moe/v4/anime/${animeId}/reviews?preliminary=false&spoilers=false`,
  );
  if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
  const j = await res.json();
  const reviews: MalReview[] = (j.data ?? [])
    .slice(0, 4)
    .map(
      (d: {
        user?: { username?: string; images?: { jpg?: { image_url?: string } } };
        score?: number;
        review?: string;
        tags?: string[];
        url?: string;
      }) => ({
        user: d.user?.username ?? '',
        avatar: d.user?.images?.jpg?.image_url ?? null,
        score: d.score ?? null,
        text: (d.review ?? '').trim(),
        tag: (d.tags ?? [])[0] ?? '',
        url: d.url ?? '',
      }),
    );

  let allUrl = `https://myanimelist.net/anime/${animeId}`;
  try {
    const a = await fetch(`https://api.jikan.moe/v4/anime/${animeId}`);
    if (a.ok) {
      const aj = await a.json();
      if (aj.data?.url) allUrl = `${aj.data.url.replace(/\/$/, '')}/reviews`;
    }
  } catch {
    /* keep the bare-anime fallback */
  }
  return { reviews, allUrl };
}

export interface MalListItem {
  id: number;
  title: string;
  picture: string | null;
  watched: number;
  total: number | null;
}

/** The signed-in user's anime list for a status, most-recently-updated first. */
export async function getUserList(
  access: string,
  status: string,
  limit = 16,
): Promise<MalListItem[]> {
  const res = await fetch(
    `${API}/users/@me/animelist?status=${status}&fields=list_status,num_episodes,main_picture&sort=list_updated_at&limit=${limit}`,
    { headers: { Authorization: `Bearer ${access}` }, cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map(
    (d: {
      node: { id: number; title: string; main_picture?: { medium?: string }; num_episodes?: number };
      list_status?: { num_episodes_watched?: number };
    }) => ({
      id: d.node.id,
      title: d.node.title,
      picture: d.node.main_picture?.medium ?? null,
      total: d.node.num_episodes || null,
      watched: d.list_status?.num_episodes_watched ?? 0,
    }),
  );
}

export interface SeasonalItem {
  id: number;
  title: string;
  picture: string | null;
  score: number | null;
  type: string | null;
}

/** Popular currently-airing shows this season, via Jikan (no auth). */
export async function getSeasonal(): Promise<SeasonalItem[]> {
  const res = await fetch('https://api.jikan.moe/v4/seasons/now?sfw=true&limit=25');
  if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? [])
    .filter((d: { images?: { jpg?: { image_url?: string } }; type?: string }) => d.images?.jpg?.image_url && d.type === 'TV')
    .sort((a: { members?: number }, b: { members?: number }) => (b.members ?? 0) - (a.members ?? 0))
    .slice(0, 16)
    .map(
      (d: {
        mal_id: number;
        title: string;
        images?: { jpg?: { image_url?: string; large_image_url?: string } };
        score?: number;
        type?: string;
      }) => ({
        id: d.mal_id,
        title: d.title,
        picture: d.images?.jpg?.large_image_url ?? d.images?.jpg?.image_url ?? null,
        score: d.score ?? null,
        type: d.type ?? null,
      }),
    );
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
