import { DEFAULT_SETTINGS, getSettings, saveSettings } from '@/shared/settings';
import type {
  FetchSkipEventsResponse,
  RuntimeMessage,
  TrackerToastMessage,
} from '@/shared/messages';
import { parseSkipEvents, skipEventsUrl } from '@/shared/skip-events';
import type { SkipSegment, TrackerMeta } from '@/shared/types';
import {
  clearToken,
  getMapping,
  getMappings,
  getTokenData,
  RESOLVER_VERSION,
  seriesKey,
  setMapping,
  setTokenData,
  type TrackerMapping,
} from '@/shared/tracker-store';
import {
  getAnimeDetails,
  getAnimeStatus,
  getCharacters,
  getRecommendations,
  getReviews,
  getSeasonal,
  getUserList,
  refresh,
  searchAnime,
  setMyListStatus,
} from '@/shared/mal';
import { getSession } from '@/shared/supabase';
import { handleStorageChange, syncNow } from '@/shared/sync';
import { getHistory } from '@/shared/history';
import { matchScore, normalizeTitle } from '@/shared/mal-match';

const CLOUD_SYNC_ALARM = 'cloud-sync';

/** Seed defaults on install so the panel/options never render an empty state. */
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get('settings');
  if (!current.settings) await saveSettings(DEFAULT_SETTINGS);
  // Removed feature (rating reminders) — clear any queue left by old versions.
  await chrome.storage.local.remove('pendingRatings');
});

// Periodic cloud-sync heartbeat (also catches changes made while a device was
// offline). No-ops when signed out. Ensured on every worker start — not just
// onInstalled — so a lost alarm heals itself instead of silently stopping sync.
void (async () => {
  const existing = await chrome.alarms.get(CLOUD_SYNC_ALARM).catch(() => undefined);
  if (!existing) chrome.alarms.create(CLOUD_SYNC_ALARM, { periodInMinutes: 15 });
})();

// Open the side panel when the toolbar icon is clicked (replaces the popup).
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[Crunchyroll Companion] side panel setup failed:', err));

// ---- cloud sync -------------------------------------------------------------

// Debounced push when synced data changes locally; periodic pull via the alarm.
chrome.storage.onChanged.addListener(handleStorageChange);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOUD_SYNC_ALARM) void syncNow();
});
// Pull once on startup so a device that was edited elsewhere catches up promptly.
chrome.runtime.onStartup.addListener(() => void syncOnStartup());
async function syncOnStartup(): Promise<void> {
  if (await getSession()) void syncNow();
}

// ---- skip-events fetch (avoids content-script CORS) -------------------------

const skipCache = new Map<string, SkipSegment[]>();
// In-flight requests, so concurrent frames asking for the same episode share one
// fetch instead of each hitting the network before the cache populates.
const skipInflight = new Map<string, Promise<FetchSkipEventsResponse>>();

async function fetchSkipEvents(episodeId: string): Promise<FetchSkipEventsResponse> {
  if (skipCache.has(episodeId)) return { ok: true, segments: skipCache.get(episodeId)! };
  const inflight = skipInflight.get(episodeId);
  if (inflight) return inflight;

  const request = (async (): Promise<FetchSkipEventsResponse> => {
    try {
      const res = await fetch(skipEventsUrl(episodeId), { credentials: 'omit' });
      if (!res.ok) return { ok: false, segments: [], error: `HTTP ${res.status}` };
      const segments = parseSkipEvents(await res.json());
      skipCache.set(episodeId, segments);
      return { ok: true, segments };
    } catch (err) {
      return { ok: false, segments: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      skipInflight.delete(episodeId);
    }
  })();

  skipInflight.set(episodeId, request);
  return request;
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

function toast(tabId: number, text: string, celebrate = false): void {
  void chrome.tabs
    .sendMessage<TrackerToastMessage>(tabId, { type: 'TRACKER_TOAST', text, celebrate })
    .catch(() => {});
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
    // Refresh token is dead (revoked/expired). Clear the stored token so the UI
    // reflects "not connected" and prompts a reconnect instead of silently
    // no-op'ing every sync while still showing "Connected".
    await clearToken();
    return null;
  }
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
    console.log('%c[Crunchyroll Companion]', 'color:#f47521;font-weight:700', ...a);

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
    toast(tabId, 'Crunchyroll Companion: connect MyAnimeList in settings to sync progress');
    return;
  }

  try {
    const mapping = await resolveMapping(access, meta);
    if (!mapping) {
      log('watched: no MAL match for', meta.series);
      toast(tabId, `Crunchyroll Companion: couldn't find "${meta.series}" on MyAnimeList`);
      return;
    }
    const current = await getAnimeStatus(access, mapping.mediaId).catch(() => null);
    const total = mapping.episodes ?? current?.total ?? null;
    // Non-destructive: only ever move progress FORWARD. Prevents a casual
    // rewatch / jumping to an earlier episode from dragging your count down.
    const watched = Math.max(current?.watched ?? 0, meta.episode);
    const reachedFinale = total != null && watched >= total;

    const patch: {
      num_watched_episodes: number;
      status?: string;
      is_rewatching?: boolean;
      num_times_rewatched?: number;
    } = { num_watched_episodes: watched };

    // What happened, for the toast + rating reminder after the write lands.
    let finishedRewatch = false;
    let justCompleted = false;

    if (current?.rewatching) {
      // Rewatch in progress: bump the episode. When it reaches the finale,
      // finalize — clear is_rewatching and increment the rewatch count — instead
      // of leaving the entry stuck mid-rewatch forever.
      if (reachedFinale) {
        patch.is_rewatching = false;
        patch.num_times_rewatched = (current.rewatchCount ?? 0) + 1;
        finishedRewatch = true;
      }
    } else if (reachedFinale) {
      patch.status = 'completed';
      // First time crossing the finale (not already completed) → offer a rating.
      justCompleted = current?.status !== 'completed';
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
      finishedRewatch ? 'rewatch-finalized' : '',
    );
    await setMyListStatus(access, mapping.mediaId, patch);
    log('watched: MAL updated OK', `${mapping.title} • episode ${watched}`);

    if (justCompleted) {
      log('watched: series completed', mapping.title);
      toast(tabId, `Finished ${mapping.title} — marked Completed on MyAnimeList ✓`, true);
    } else if (finishedRewatch) {
      toast(tabId, `Rewatch complete: ${mapping.title} ✓`, true);
    } else {
      toast(tabId, `MyAnimeList updated: ${mapping.title} • episode ${watched}`);
    }
  } catch (err) {
    log('watched: MAL sync FAILED', err);
    toast(tabId, `Crunchyroll Companion: MAL sync failed (${err instanceof Error ? err.message : 'error'})`);
  }
}

/**
 * Pick the show to seed "because you watched…" recommendations from: a RANDOM
 * history entry we can already map to a MAL id, so the rail varies between
 * panel opens instead of always reflecting the most recent show. Only when no
 * mapping is cached yet does it resolve the single latest entry, so this never
 * fans out a search per history item.
 */
async function pickRecommendationSeed(
  access: string | null,
): Promise<{ animeId: number; title: string } | null> {
  const history = await getHistory();
  if (!history.length) return null;
  const mappings = await getMappings(); // one storage read, not one per entry
  const candidates: Array<{ animeId: number; title: string }> = [];
  for (const h of history) {
    const m = mappings[seriesKey({ series: h.series, season: h.season })];
    if (m) candidates.push({ animeId: m.mediaId, title: h.series });
  }
  if (candidates.length) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  const latest = history[0];
  const mapping = await resolveMapping(access, {
    episodeId: latest.episodeId,
    series: latest.series,
    season: latest.season,
    episode: latest.episode,
    episodeTitle: latest.episodeTitle,
    thumbnail: latest.thumbnail,
  });
  return mapping ? { animeId: mapping.mediaId, title: latest.series } : null;
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
          airingStatus: d.airingStatus,
          broadcastDay: d.broadcastDay,
          broadcastTime: d.broadcastTime,
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
    case 'GET_MAL_REVIEWS': {
      getReviews(message.animeId)
        .then(({ reviews, allUrl }) => sendResponse({ ok: true, reviews, allUrl }))
        .catch(() => sendResponse({ ok: false, reviews: [] }));
      return true; // async response
    }
    case 'GET_MY_LIST': {
      (async () => {
        const access = await validAccessToken();
        if (!access) return sendResponse({ ok: false, connected: false, items: [] });
        const items = await getUserList(access, message.status).catch(() => []);
        sendResponse({ ok: true, connected: true, items });
      })().catch(() => sendResponse({ ok: false, connected: false, items: [] }));
      return true; // async response
    }
    case 'GET_SEASONAL': {
      getSeasonal()
        .then((items) => sendResponse({ ok: true, items }))
        .catch(() => sendResponse({ ok: false, items: [] }));
      return true; // async response
    }
    case 'GET_RECOMMENDATIONS': {
      (async () => {
        const access = await validAccessToken();
        const seed = await pickRecommendationSeed(access);
        if (!seed) return sendResponse({ ok: false, items: [] });
        const recs = await getRecommendations(seed.animeId).catch(() => []);
        // Drop shows already in the user's history — recommend the unseen.
        // Fully non-Latin titles normalize to '' (the normalizer is a-z0-9 only);
        // skip those rather than let every such title match every other.
        const seen = new Set(
          (await getHistory()).map((h) => normalizeTitle(h.series)).filter(Boolean),
        );
        const items = recs.filter((r) => {
          const n = normalizeTitle(r.title);
          return !n || !seen.has(n);
        });
        sendResponse({ ok: items.length > 0, seedTitle: seed.title, items });
      })().catch(() => sendResponse({ ok: false, items: [] }));
      return true; // async response
    }
    case 'SYNC_NOW': {
      syncNow().then(sendResponse);
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
        console.warn('[Crunchyroll Companion] MAL update failed:', err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : 'error' });
      });
      return true; // async response
    }
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void clearTabMeta(tabId));
