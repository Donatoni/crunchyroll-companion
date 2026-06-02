import { DEFAULT_SETTINGS, getSettings, saveSettings } from '@/shared/settings';
import type {
  FetchSkipEventsResponse,
  RuntimeMessage,
  TrackerToastMessage,
} from '@/shared/messages';
import { parseSkipEvents, skipEventsUrl } from '@/shared/skip-events';
import type { SkipSegment, TrackerMeta } from '@/shared/types';
import {
  getMapping,
  getTokenData,
  RESOLVER_VERSION,
  seriesKey,
  setMapping,
  setTokenData,
  type TrackerMapping,
} from '@/shared/tracker-store';
import {
  authorizeUrl,
  exchangeCode,
  getAnimeDetails,
  getAnimeStatus,
  getCharacters,
  getUserName,
  randomVerifier,
  refresh,
  searchAnime,
  setMyListStatus,
} from '@/shared/mal';

/** Seed defaults on install so the panel/options never render an empty state. */
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get('settings');
  if (!current.settings) await saveSettings(DEFAULT_SETTINGS);
});

// Open the side panel when the toolbar icon is clicked (replaces the popup).
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[Crunchy Tools] side panel setup failed:', err));

// ---- skip-events fetch (avoids content-script CORS) -------------------------

const skipCache = new Map<string, SkipSegment[]>();

async function fetchSkipEvents(episodeId: string): Promise<FetchSkipEventsResponse> {
  if (skipCache.has(episodeId)) return { ok: true, segments: skipCache.get(episodeId)! };
  try {
    const res = await fetch(skipEventsUrl(episodeId), { credentials: 'omit' });
    if (!res.ok) return { ok: false, segments: [], error: `HTTP ${res.status}` };
    const segments = parseSkipEvents(await res.json());
    skipCache.set(episodeId, segments);
    return { ok: true, segments };
  } catch (err) {
    return { ok: false, segments: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- tracker (cross-frame hub) ---------------------------------------------

/**
 * Latest episode metadata per tab (set by the top frame).
 *
 * Persisted in storage.session — NOT an in-memory Map — because the MV3 service
 * worker is evicted after ~30s idle, and a long episode plays for ~20 minutes
 * with no messages to keep it alive. The "watched" event fires ~80% in, long
 * after the worker (and any in-memory state) would have been torn down; an
 * in-memory map would be empty by then and the tracker sync would silently
 * no-op. storage.session lives for the whole browser session and is restored
 * when the worker restarts, so the metadata is still there when we need it.
 */
const metaKey = (tabId: number) => `tabMeta:${tabId}`;

async function setTabMeta(tabId: number, meta: TrackerMeta): Promise<void> {
  await chrome.storage.session.set({ [metaKey(tabId)]: meta });
}

async function getTabMeta(tabId: number): Promise<TrackerMeta | null> {
  const key = metaKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as TrackerMeta | undefined) ?? null;
}

async function clearTabMeta(tabId: number): Promise<void> {
  await chrome.storage.session.remove(metaKey(tabId));
}

function toast(tabId: number, text: string): void {
  void chrome.tabs
    .sendMessage<TrackerToastMessage>(tabId, { type: 'TRACKER_TOAST', text })
    .catch(() => {});
}

/**
 * Run the MyAnimeList OAuth (PKCE) flow and store the token. Lives here rather
 * than in the popup because `launchWebAuthFlow` opens a focused window that
 * closes the popup mid-flow; the service worker survives, so connecting from the
 * popup's settings modal still completes.
 */
async function startMalAuth(): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const redirectUri = chrome.identity.getRedirectURL();
    const verifier = randomVerifier(); // PKCE "plain": challenge == verifier
    const state = randomVerifier().slice(0, 16);
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authorizeUrl(verifier, redirectUri, state),
      interactive: true,
    });
    const params = new URLSearchParams((responseUrl ?? '').split('?')[1] ?? '');
    if (params.get('state') !== state) throw new Error('State mismatch');
    const code = params.get('code');
    if (!code) throw new Error(params.get('error') ?? 'No authorization code');
    const token = await exchangeCode(code, verifier, redirectUri);
    await setTokenData(token);
    const name = await getUserName(token.access).catch(() => undefined);
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'error' };
  }
}

/** Return a valid MAL access token, refreshing it if expired. */
async function validAccessToken(): Promise<string | null> {
  const data = await getTokenData();
  if (!data) return null;
  if (Date.now() < data.expiresAt - 60_000) return data.access;
  try {
    const fresh = await refresh(data.refresh);
    await setTokenData(fresh);
    return fresh.access;
  } catch {
    return null;
  }
}

/** Normalize a title for fuzzy comparison (lowercase, alphanumerics only). */
function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Best-effort season number a (normalized) title refers to. Defaults to 1.
 * `baseName` is the series name we're matching against, so a number that's part
 * of the name itself (e.g. "Mob Psycho 100") isn't mistaken for a season.
 */
function detectSeason(normalizedTitle: string, baseName: string): number {
  const t = normalizedTitle;
  let m = t.match(/\bseason\s+(\d+)\b/) ?? t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
  if (m) return Number(m[1]);
  if (/\bfinal\s+season\b/.test(t)) return 99;
  if (/\biv\b/.test(t)) return 4;
  if (/\biii\b/.test(t)) return 3;
  if (/\bii\b/.test(t)) return 2;
  // A trailing small number ("… 2") reads as a season, unless it's part of the
  // base name itself.
  m = t.match(/\b(\d{1,2})\s*$/);
  if (m && !normalizeTitle(baseName).includes(m[1])) {
    const n = Number(m[1]);
    if (n >= 2 && n <= 20) return n;
  }
  return 1;
}

/** Plain title-similarity score (0–100), no season logic. */
function titleSimilarity(q: string, t: string): number {
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q) || q.startsWith(t)) return 80;
  if (t.includes(q) || q.includes(t)) return 55;
  const qWords = new Set(q.split(' '));
  const tWords = t.split(' ');
  const overlap = tWords.filter((w) => qWords.has(w)).length;
  return (overlap / Math.max(qWords.size, tWords.length)) * 50;
}

/**
 * Score how well a MAL anime matches the Crunchyroll series + season. Higher is
 * better.
 *  - Title exactness stops "Black Clover" from resolving to the chibi short
 *    "Mugyutto! Black Clover" (which merely *contains* the name).
 *  - Season alignment stops "Fire Force" (season 2 on CR) from snapping to the
 *    season-1 entry, which matches the franchise name exactly.
 *  - Full TV series are preferred over shorts/specials/spin-offs.
 */
function matchScore(
  seriesName: string,
  season: number | null,
  anime: { title: string; altTitles: string[]; mediaType: string | null },
): number {
  const q = normalizeTitle(seriesName);
  if (!q) return 0;
  const target = season && season > 0 ? season : 1;

  let bestTitle = 0;
  let candSeason = 1;
  for (const candidate of [anime.title, ...anime.altTitles]) {
    const t = normalizeTitle(candidate);
    const s = titleSimilarity(q, t);
    if (s > bestTitle) {
      bestTitle = s;
      candSeason = detectSeason(t, seriesName);
    }
  }

  let score = bestTitle;
  if (anime.mediaType === 'tv') score += 6;
  score += candSeason === target ? 14 : -22; // season match bonus / mismatch penalty
  return score;
}

/** Resolve (and cache) the MAL anime for a CR series+season. */
async function resolveMapping(
  access: string | null,
  meta: TrackerMeta,
): Promise<TrackerMapping | null> {
  const key = seriesKey(meta);
  const cached = await getMapping(key);
  // Use the cache only if the user pinned it or it was produced by the current
  // resolver. Legacy mappings (e.g. ones that picked a spin-off) get re-resolved
  // with the improved matcher below, then re-cached.
  if (cached && (cached.pinned || cached.v === RESOLVER_VERSION)) return cached;

  // Build progressively looser queries; long Crunchyroll titles often don't
  // match MAL verbatim. Season > 1 entries are separate MAL anime.
  const base = meta.series.trim();
  const queries: string[] = [];
  const add = (q: string) => {
    const t = q.trim();
    if (t.length >= 3 && !queries.includes(t)) queries.push(t);
  };
  if (meta.season && meta.season > 1) add(`${base} ${meta.season}`);
  add(base);
  add(base.split(/\s*[:–—]\s*/)[0]); // drop subtitle after a colon / em-dash
  add(base.split(',')[0]); // drop a trailing comma clause
  const words = base.split(/\s+/);
  if (words.length > 6) add(words.slice(0, 6).join(' '));
  if (words.length > 4) add(words.slice(0, 4).join(' '));

  // Score every candidate against the series name and keep the best, rather
  // than blindly trusting MAL's first search result (which can be a spin-off).
  let best: { anime: Awaited<ReturnType<typeof searchAnime>>[number]; score: number } | null = null;
  for (const q of queries) {
    const results = await searchAnime(access, q).catch(() => []);
    for (const r of results) {
      const score = matchScore(base, meta.season, r);
      if (!best || score > best.score) best = { anime: r, score };
    }
    // An exact / strong prefix match is good enough — stop widening the search.
    if (best && best.score >= 80) break;
  }

  if (best) {
    const mapping: TrackerMapping = {
      mediaId: best.anime.id,
      title: best.anime.title || meta.series,
      episodes: best.anime.episodes,
      v: RESOLVER_VERSION,
    };
    await setMapping(key, mapping);
    return mapping;
  }
  return null;
}

async function onEpisodeWatched(tabId: number, episodeId: string): Promise<void> {
  const log = (...a: unknown[]) =>
    console.log('%c[Crunchy Tools]', 'color:#f47521;font-weight:700', ...a);

  const settings = await getSettings();
  if (!settings.enabled || !settings.mal.enabled) {
    log('watched: ignored (extension or MAL sync disabled)');
    return;
  }

  const meta = await getTabMeta(tabId);
  if (!meta) {
    log('watched: no stored meta for tab', tabId, '(episode', episodeId + ')');
    return;
  }
  if (meta.episode == null) {
    log('watched: stored meta has no episode number', meta.series);
    return;
  }
  log('watched: syncing', `${meta.series} E${meta.episode}`, '(tab', tabId + ')');

  const access = await validAccessToken();
  if (!access) {
    log('watched: no MAL access token — not connected');
    toast(tabId, 'Crunchy Tools: connect MyAnimeList in settings to sync progress');
    return;
  }

  try {
    const mapping = await resolveMapping(access, meta);
    if (!mapping) {
      log('watched: no MAL match for', meta.series);
      toast(tabId, `Crunchy Tools: couldn't find "${meta.series}" on MyAnimeList`);
      return;
    }
    const current = await getAnimeStatus(access, mapping.mediaId).catch(() => null);
    const total = mapping.episodes ?? current?.total ?? null;
    // Non-destructive: only ever move progress FORWARD. Prevents a casual
    // rewatch / jumping to an earlier episode from dragging your count down.
    const watched = Math.max(current?.watched ?? 0, meta.episode);

    const patch: { num_watched_episodes: number; status?: string } = {
      num_watched_episodes: watched,
    };
    if (current?.rewatching) {
      // Rewatch in progress: bump the episode only; keep completed +
      // is_rewatching (MAL finalizes num_times_rewatched at the total).
    } else if (total != null && watched >= total) {
      patch.status = 'completed';
    } else if (current?.status !== 'completed') {
      // Actively watching, not finished, not already completed → watching.
      // Don't downgrade a completed entry or override on-hold/dropped→completed.
      patch.status = 'watching';
    }
    log(
      'watched: pushing to MAL',
      `"${mapping.title}" (#${mapping.mediaId})`,
      `${current?.watched ?? 0} -> ${watched}`,
      patch.status ? `status=${patch.status}` : '',
    );
    await setMyListStatus(access, mapping.mediaId, patch);
    log('watched: MAL updated OK', `${mapping.title} • episode ${watched}`);
    toast(tabId, `MyAnimeList updated: ${mapping.title} • episode ${watched}`);
  } catch (err) {
    log('watched: MAL sync FAILED', err);
    toast(tabId, `Crunchy Tools: MAL sync failed (${err instanceof Error ? err.message : 'error'})`);
  }
}

// ---- message router ---------------------------------------------------------

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  switch (message?.type) {
    case 'FETCH_SKIP_EVENTS':
      fetchSkipEvents(message.episodeId).then(sendResponse);
      return true; // async response
    case 'EPISODE_META':
      if (sender.tab?.id != null) void setTabMeta(sender.tab.id, message.meta);
      return false;
    case 'EPISODE_WATCHED':
      if (sender.tab?.id != null) void onEpisodeWatched(sender.tab.id, message.episodeId);
      return false;
    case 'START_MAL_AUTH':
      startMalAuth().then(sendResponse);
      return true; // async response
    case 'GET_TAB_STATUS': {
      void (async () => {
        const meta = await getTabMeta(message.tabId);
        const segments = meta ? (skipCache.get(meta.episodeId)?.length ?? 0) : 0;
        sendResponse({ meta, segments });
      })();
      return true; // async response
    }
    case 'GET_MAL_STATUS': {
      const meta = message.meta;
      (async () => {
        // No token still resolves PUBLIC show details (client-id) — only the
        // user's list entry needs sign-in.
        const access = await validAccessToken();
        const mapping = await resolveMapping(access, meta);
        if (!mapping) return sendResponse({ ok: false, connected: !!access });
        const d = await getAnimeDetails(access, mapping.mediaId);
        sendResponse({
          ok: true,
          connected: !!access,
          title: d.title || mapping.title,
          animeId: mapping.mediaId,
          total: d.total,
          watched: d.watched,
          status: d.status,
          score: d.score,
          mean: d.mean,
          rewatching: d.rewatching,
          rewatchCount: d.rewatchCount,
          synopsis: d.synopsis,
          picture: d.picture,
          genres: d.genres,
          rank: d.rank,
          mediaType: d.mediaType,
          year: d.year,
          studios: d.studios,
          related: d.related,
        });
      })().catch(() => sendResponse({ ok: false }));
      return true; // async response
    }
    case 'GET_MAL_CHARACTERS': {
      getCharacters(message.animeId)
        .then((characters) => sendResponse({ ok: true, characters }))
        .catch(() => sendResponse({ ok: false, characters: [] }));
      return true; // async response
    }
    case 'SET_MAL_STATUS': {
      const { meta, patch } = message;
      (async () => {
        const access = await validAccessToken();
        if (!access) return sendResponse({ ok: false, connected: false });
        const mapping = await resolveMapping(access, meta);
        if (!mapping) return sendResponse({ ok: false, connected: true });
        await setMyListStatus(access, mapping.mediaId, patch);
        const s = await getAnimeStatus(access, mapping.mediaId);
        sendResponse({
          ok: true,
          connected: true,
          title: mapping.title,
          animeId: mapping.mediaId,
          total: s.total,
          watched: s.watched,
          status: s.status,
          score: s.score,
          mean: s.mean,
          rewatching: s.rewatching,
          rewatchCount: s.rewatchCount,
        });
      })().catch((err) => {
        console.warn('[Crunchy Tools] MAL update failed:', err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : 'error' });
      });
      return true; // async response
    }
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void clearTabMeta(tabId));
