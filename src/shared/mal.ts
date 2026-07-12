/**
 * Minimal MyAnimeList API v2 client.
 *
 * MAL uses OAuth2 authorization-code + PKCE. Public clients (app type "other")
 * need no client secret. We use code_challenge_method=plain (challenge ==
 * verifier). NOTE: MyAnimeList only supports the `plain` method — it rejects
 * `S256`, so do NOT "upgrade" this. All requests are made from contexts that
 * hold host_permissions for *.myanimelist.net, so CORS does not apply.
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

export function authorizeUrl(
  codeChallenge: string,
  redirectUri: string,
  state: string,
): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: MAL_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'plain', // MAL only supports `plain`, not `S256`
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
  // limit=20, not 10: MAL's relevance ranking can bury the main TV series
  // under a franchise's movies/specials — searching "Naruto" returns the
  // Naruto TV series at position ~14. The scorer picks the right entry only
  // if it's in the pool at all.
  const res = await fetch(
    `${API}/anime?q=${encodeURIComponent(q)}&limit=20&fields=num_episodes,media_type,alternative_titles`,
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
  /** Character page on MyAnimeList, if known. */
  url: string | null;
}

export interface MalDetails extends MalStatus {
  title: string;
  synopsis: string;
  /** MAL "background" — prose trivia (awards, records, releases). Often empty. */
  background: string;
  /** Poster image (MAL main_picture). */
  picture: string | null;
  genres: string[];
  rank: number | null;
  mediaType: string | null;
  year: number | null;
  studios: string[];
  related: MalRelated[];
  /** MAL airing status: currently_airing / finished_airing / not_yet_aired. */
  airingStatus: string | null;
  /** Weekly broadcast slot (JST), when the show is airing on a schedule. */
  broadcastDay: string | null;
  broadcastTime: string | null;
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
    'title,synopsis,background,main_picture,genres,mean,rank,num_episodes,media_type,start_season,studios,status,broadcast,' +
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
    background: j.background ?? '',
    picture: j.main_picture?.large ?? j.main_picture?.medium ?? null,
    genres: (j.genres ?? []).map((g: { name: string }) => g.name),
    mean: j.mean ?? null,
    rank: j.rank ?? null,
    total: j.num_episodes || null,
    mediaType: j.media_type ?? null,
    year: j.start_season?.year ?? null,
    studios: (j.studios ?? []).map((s: { name: string }) => s.name),
    airingStatus: j.status ?? null,
    broadcastDay: j.broadcast?.day_of_the_week ?? null,
    broadcastTime: j.broadcast?.start_time ?? null,
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

// ── AniList (characters) ────────────────────────────────────────────
// MAL's own v2 API has no character endpoint. AniList is a FIRST-PARTY GraphQL
// API — it queries its own database, NOT a scraper like Jikan (which is shutting
// down 2026-10-01) — and it can look an anime up BY MAL id, so our CR→MAL
// resolution is reused unchanged. Free, no auth for public data.
const ANILIST = 'https://graphql.anilist.co';

/** An AniList ranking accolade, e.g. "#1 Most Popular · Fall 2006". */
export interface AniRanking {
  rank: number;
  /** Accolade family: RATED (by score) or POPULAR (by members). */
  type: 'RATED' | 'POPULAR';
  /** AniList's label, e.g. "most popular all time" / "highest rated". */
  context: string;
  allTime: boolean;
  season: string | null;
  year: number | null;
}

/** A staff credit, e.g. { role: "Director", name: "Tetsurou Araki" }. */
export interface AniStaff {
  role: string;
  name: string;
  image: string | null;
  url: string | null;
}

export interface ShowExtras {
  characters: MalCharacter[];
  /** Prestige rankings (all-time + seasonal), most notable first. */
  rankings: AniRanking[];
  /** Key staff credits. */
  staff: AniStaff[];
}

const EXTRAS_QUERY = `query ($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    characters(sort: [ROLE, RELEVANCE], perPage: 14) {
      edges { role node { name { full } image { large } siteUrl } }
    }
    rankings { rank type context allTime season year }
    staff(sort: RELEVANCE, perPage: 9) { edges { role node { name { full } image { medium } siteUrl } } }
  }
}`;

/**
 * Characters + rankings + staff for an anime via AniList, looked up by MAL id,
 * in ONE request. Best-effort — callers tolerate throw / empties.
 */
export async function getShowExtras(animeId: number): Promise<ShowExtras> {
  const res = await fetch(ANILIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: EXTRAS_QUERY, variables: { idMal: animeId } }),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const j = await res.json();
  const media = j.data?.Media;

  const charEdges: Array<{
    role?: string;
    node?: { name?: { full?: string }; image?: { large?: string }; siteUrl?: string };
  }> = media?.characters?.edges ?? [];
  const characters = charEdges
    .map((e) => ({
      name: e.node?.name?.full ?? '',
      image: e.node?.image?.large ?? null,
      // AniList roles are MAIN / SUPPORTING / BACKGROUND (the UI upper-cases anyway).
      role: e.role ?? '',
      url: e.node?.siteUrl ?? null,
    }))
    .filter((c) => c.name);

  const rawRankings: Array<{
    rank?: number;
    type?: string;
    context?: string;
    allTime?: boolean;
    season?: string | null;
    year?: number | null;
  }> = media?.rankings ?? [];
  // Return every accolade (AniList caps at ~6 per show: rated/popular ×
  // all-time/year/season); the renderer normalizes them into fixed slots.
  const rankings: AniRanking[] = rawRankings
    .filter((r) => typeof r.rank === 'number' && r.context)
    .map((r) => ({
      rank: r.rank as number,
      // Fall back to sniffing the context so a missing `type` degrades sanely.
      type: (r.type === 'RATED' || /rated|score/i.test(r.context as string)
        ? 'RATED'
        : 'POPULAR') as AniRanking['type'],
      context: r.context as string,
      allTime: !!r.allTime,
      season: r.season ?? null,
      year: r.year ?? null,
    }))
    .sort((a, b) => Number(b.allTime) - Number(a.allTime) || a.rank - b.rank)
    .slice(0, 8);

  const staffEdges: Array<{
    role?: string;
    node?: { name?: { full?: string }; image?: { medium?: string }; siteUrl?: string };
  }> = media?.staff?.edges ?? [];
  // One card per person: AniList lists someone once per role, so merge
  // duplicates ("Director" + "Storyboard" → "Director · Storyboard").
  const byName = new Map<string, AniStaff>();
  for (const e of staffEdges) {
    const name = e.node?.name?.full ?? '';
    if (!name || !e.role) continue;
    const prev = byName.get(name);
    if (prev) {
      if (!prev.role.includes(e.role)) prev.role += ` · ${e.role}`;
    } else {
      byName.set(name, {
        role: e.role,
        name,
        image: e.node?.image?.medium ?? null,
        url: e.node?.siteUrl ?? null,
      });
    }
  }
  const staff = [...byName.values()].slice(0, 6);

  return { characters, rankings, staff };
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
    `${API}/users/@me/animelist?status=${status}&fields=list_status,num_episodes,main_picture,alternative_titles&sort=list_updated_at&limit=${limit}`,
    { headers: { Authorization: `Bearer ${access}` }, cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map(
    (d: {
      node: {
        id: number;
        title: string;
        alternative_titles?: { en?: string };
        main_picture?: { medium?: string };
        num_episodes?: number;
      };
      list_status?: { num_episodes_watched?: number };
    }) => ({
      id: d.node.id,
      // Prefer the official English title; fall back to the romaji default.
      title: d.node.alternative_titles?.en || d.node.title,
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

interface MalAnimeCard {
  node: {
    id: number;
    title: string;
    main_picture?: { medium?: string; large?: string };
    mean?: number;
    media_type?: string;
    alternative_titles?: { en?: string };
  };
}

/** Map a MAL anime node (from recommendations / ranking) to a poster-rail item. */
function toSeasonalItem(node: MalAnimeCard['node'], score: number | null, type: string | null): SeasonalItem {
  return {
    id: node.id,
    // Prefer the official English title; fall back to the romaji default.
    title: node.alternative_titles?.en || node.title,
    picture: node.main_picture?.large ?? node.main_picture?.medium ?? null,
    score,
    type,
  };
}

/**
 * "Because you watched X" picks via the OFFICIAL MAL API (anime details carry a
 * `recommendations` field — community "if you liked this…" links, ordered by
 * vote count). Works with the client-id header, so no sign-in needed.
 */
export async function getRecommendations(
  access: string | null,
  animeId: number,
): Promise<SeasonalItem[]> {
  const res = await fetch(
    `${API}/anime/${animeId}?fields=recommendations`,
    { headers: authHeaders(access), cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
  const j = await res.json();
  return (j.recommendations ?? [])
    .slice(0, 16)
    .map((d: { node: MalAnimeCard['node']; num_recommendations?: number }) => {
      const n = d.num_recommendations ?? 0;
      return toSeasonalItem(d.node, null, n ? `${n} rec${n === 1 ? '' : 's'}` : null);
    })
    .filter((r: SeasonalItem) => r.id && r.title && r.picture);
}

/**
 * Popular currently-airing shows via the OFFICIAL MAL API ranking endpoint
 * (`ranking_type=airing`). Works with the client-id header.
 */
export async function getSeasonal(access: string | null): Promise<SeasonalItem[]> {
  const res = await fetch(
    `${API}/anime/ranking?ranking_type=airing&limit=20&fields=mean,media_type,alternative_titles`,
    { headers: authHeaders(access), cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
  const j = await res.json();
  return (j.data ?? [])
    .map((d: MalAnimeCard) => d.node)
    .filter((n: MalAnimeCard['node']) => n.media_type === 'tv' && n.main_picture)
    .slice(0, 16)
    .map((n: MalAnimeCard['node']) =>
      toSeasonalItem(n, n.mean ?? null, n.media_type ? n.media_type.toUpperCase() : null),
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
