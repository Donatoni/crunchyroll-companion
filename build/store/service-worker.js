"use strict";
(() => {
  // src/shared/settings.ts
  var DEFAULT_SETTINGS = {
    enabled: true,
    skip: {
      intro: true,
      recap: true,
      credits: true,
      preview: true
    },
    autoNext: true,
    keepWatching: true,
    showToast: true,
    mode: "seek",
    mal: {
      enabled: false
    }
  };
  var STORAGE_KEY = "settings";
  function withDefaults(stored) {
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      skip: { ...DEFAULT_SETTINGS.skip, ...stored?.skip ?? {} },
      mal: { ...DEFAULT_SETTINGS.mal, ...stored?.mal ?? {} }
    };
  }
  async function getSettings() {
    const raw = await chrome.storage.sync.get(STORAGE_KEY);
    return withDefaults(raw[STORAGE_KEY]);
  }
  async function saveSettings(settings) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  }

  // src/shared/types.ts
  var SKIP_TYPES = ["intro", "recap", "credits", "preview"];

  // src/shared/skip-events.ts
  function skipEventsUrl(episodeId) {
    return `https://static.crunchyroll.com/skip-events/production/${encodeURIComponent(
      episodeId
    )}.json`;
  }
  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }
  function parseSkipEvents(raw) {
    if (!raw || typeof raw !== "object") return [];
    const obj = raw;
    const segments = [];
    for (const type of SKIP_TYPES) {
      const entry = obj[type];
      if (!entry || typeof entry !== "object") continue;
      const { start, end } = entry;
      if (!isFiniteNumber(start) || !isFiniteNumber(end)) continue;
      if (end <= start) continue;
      segments.push({ type, start, end });
    }
    return segments.sort((a, b) => a.start - b.start);
  }

  // src/shared/tracker-store.ts
  var TOKEN_KEY = "mal_token";
  var MAP_KEY = "mal_mappings";
  var RESOLVER_VERSION = 2;
  function seriesKey(meta) {
    return `${meta.series.trim().toLowerCase()}__s${meta.season ?? 1}`;
  }
  async function getTokenData() {
    const r = await chrome.storage.local.get(TOKEN_KEY);
    return r[TOKEN_KEY] ?? null;
  }
  async function setTokenData(token) {
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
  }
  async function getMappings() {
    const r = await chrome.storage.local.get(MAP_KEY);
    return r[MAP_KEY] ?? {};
  }
  async function getMapping(key) {
    return (await getMappings())[key] ?? null;
  }
  async function setMapping(key, value) {
    const all = await getMappings();
    all[key] = value;
    await chrome.storage.local.set({ [MAP_KEY]: all });
  }

  // src/shared/mal-config.ts
  var MAL_CLIENT_ID = "9bb4b1bb5cdb9697b154bc9739f9e607";

  // src/shared/mal.ts
  var AUTHORIZE = "https://myanimelist.net/v1/oauth2/authorize";
  var TOKEN = "https://myanimelist.net/v1/oauth2/token";
  var API = "https://api.myanimelist.net/v2";
  function authHeaders(access) {
    return access ? { Authorization: `Bearer ${access}` } : { "X-MAL-CLIENT-ID": MAL_CLIENT_ID };
  }
  function randomVerifier() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const bytes = new Uint8Array(96);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }
  function authorizeUrl(codeChallenge, redirectUri, state) {
    const p = new URLSearchParams({
      response_type: "code",
      client_id: MAL_CLIENT_ID,
      code_challenge: codeChallenge,
      code_challenge_method: "plain",
      redirect_uri: redirectUri,
      state
    });
    return `${AUTHORIZE}?${p.toString()}`;
  }
  async function postToken(body) {
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!res.ok) throw new Error(`MAL token HTTP ${res.status}`);
    const j = await res.json();
    return {
      access: j.access_token,
      refresh: j.refresh_token,
      expiresAt: Date.now() + Number(j.expires_in) * 1e3
    };
  }
  function exchangeCode(code, codeVerifier, redirectUri) {
    return postToken(
      new URLSearchParams({
        client_id: MAL_CLIENT_ID,
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri
      })
    );
  }
  async function refresh(refreshToken) {
    const t = await postToken(
      new URLSearchParams({
        client_id: MAL_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    );
    return { ...t, refresh: t.refresh || refreshToken };
  }
  async function getUserName(access) {
    const res = await fetch(`${API}/users/@me?fields=name`, {
      headers: { Authorization: `Bearer ${access}` }
    });
    if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
    return (await res.json()).name;
  }
  async function searchAnime(access, q) {
    const res = await fetch(
      `${API}/anime?q=${encodeURIComponent(q)}&limit=10&fields=num_episodes,media_type,alternative_titles`,
      { headers: authHeaders(access) }
    );
    if (!res.ok) throw new Error(`MAL search HTTP ${res.status}`);
    const j = await res.json();
    return (j.data ?? []).map((d) => ({
      id: d.node.id,
      title: d.node.title,
      episodes: d.node.num_episodes || null,
      mediaType: d.node.media_type ?? null,
      altTitles: [
        d.node.alternative_titles?.en,
        d.node.alternative_titles?.ja,
        ...d.node.alternative_titles?.synonyms ?? []
      ].filter((t) => !!t)
    }));
  }
  async function getAnimeStatus(access, animeId) {
    const res = await fetch(
      `${API}/anime/${animeId}?fields=num_episodes,mean,my_list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched}`,
      { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" }
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
      rewatchCount: m?.num_times_rewatched ?? 0
    };
  }
  async function getAnimeDetails(access, animeId) {
    const fields = "title,synopsis,main_picture,genres,mean,rank,num_episodes,media_type,start_season,studios,related_anime{media_type,num_episodes,main_picture}" + (access ? ",my_list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched}" : "");
    const res = await fetch(`${API}/anime/${animeId}?fields=${fields}`, {
      headers: authHeaders(access),
      cache: "no-store"
    });
    if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
    const j = await res.json();
    const m = j.my_list_status;
    return {
      title: j.title ?? "",
      synopsis: j.synopsis ?? "",
      picture: j.main_picture?.large ?? j.main_picture?.medium ?? null,
      genres: (j.genres ?? []).map((g) => g.name),
      mean: j.mean ?? null,
      rank: j.rank ?? null,
      total: j.num_episodes || null,
      mediaType: j.media_type ?? null,
      year: j.start_season?.year ?? null,
      studios: (j.studios ?? []).map((s) => s.name),
      related: (j.related_anime ?? []).map(
        (r) => ({
          id: r.node.id,
          title: r.node.title,
          picture: r.node.main_picture?.medium ?? null,
          mediaType: r.node.media_type ?? null,
          episodes: r.node.num_episodes || null,
          relation: r.relation_type_formatted ?? r.relation_type ?? ""
        })
      ),
      status: m?.status ?? null,
      score: m?.score || null,
      watched: m?.num_episodes_watched ?? 0,
      rewatching: !!m?.is_rewatching,
      rewatchCount: m?.num_times_rewatched ?? 0
    };
  }
  async function getCharacters(animeId) {
    const res = await fetch(`https://api.jikan.moe/v4/anime/${animeId}/characters`);
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    const j = await res.json();
    return (j.data ?? []).slice(0, 14).map((d) => ({
      name: d.character?.name ?? "",
      image: d.character?.images?.jpg?.image_url ?? null,
      role: d.role ?? ""
    }));
  }
  async function getReviews(animeId) {
    const res = await fetch(
      `https://api.jikan.moe/v4/anime/${animeId}/reviews?preliminary=false&spoilers=false`
    );
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    const j = await res.json();
    const reviews = (j.data ?? []).slice(0, 4).map(
      (d) => ({
        user: d.user?.username ?? "",
        avatar: d.user?.images?.jpg?.image_url ?? null,
        score: d.score ?? null,
        text: (d.review ?? "").trim(),
        tag: (d.tags ?? [])[0] ?? "",
        url: d.url ?? ""
      })
    );
    let allUrl = `https://myanimelist.net/anime/${animeId}`;
    try {
      const a = await fetch(`https://api.jikan.moe/v4/anime/${animeId}`);
      if (a.ok) {
        const aj = await a.json();
        if (aj.data?.url) allUrl = `${aj.data.url.replace(/\/$/, "")}/reviews`;
      }
    } catch {
    }
    return { reviews, allUrl };
  }
  async function getUserList(access, status, limit = 16) {
    const res = await fetch(
      `${API}/users/@me/animelist?status=${status}&fields=list_status,num_episodes,main_picture&sort=list_updated_at&limit=${limit}`,
      { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" }
    );
    if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
    const j = await res.json();
    return (j.data ?? []).map(
      (d) => ({
        id: d.node.id,
        title: d.node.title,
        picture: d.node.main_picture?.medium ?? null,
        total: d.node.num_episodes || null,
        watched: d.list_status?.num_episodes_watched ?? 0
      })
    );
  }
  async function getSeasonal() {
    const res = await fetch("https://api.jikan.moe/v4/seasons/now?sfw=true&limit=25");
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    const j = await res.json();
    return (j.data ?? []).filter((d) => d.images?.jpg?.image_url && d.type === "TV").sort((a, b) => (b.members ?? 0) - (a.members ?? 0)).slice(0, 16).map(
      (d) => ({
        id: d.mal_id,
        title: d.title,
        picture: d.images?.jpg?.large_image_url ?? d.images?.jpg?.image_url ?? null,
        score: d.score ?? null,
        type: d.type ?? null
      })
    );
  }
  async function setMyListStatus(access, animeId, patch) {
    const body = new URLSearchParams();
    if (patch.num_watched_episodes != null)
      body.set("num_watched_episodes", String(patch.num_watched_episodes));
    if (patch.status) body.set("status", patch.status);
    if (patch.score != null) body.set("score", String(patch.score));
    if (patch.is_rewatching != null)
      body.set("is_rewatching", String(patch.is_rewatching));
    if (patch.num_times_rewatched != null)
      body.set("num_times_rewatched", String(patch.num_times_rewatched));
    const res = await fetch(`${API}/anime/${animeId}/my_list_status`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body,
      cache: "no-store"
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${detail}`.trim().slice(0, 180));
    }
  }

  // src/background/service-worker.ts
  chrome.runtime.onInstalled.addListener(async () => {
    const current = await chrome.storage.sync.get("settings");
    if (!current.settings) await saveSettings(DEFAULT_SETTINGS);
  });
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => void 0);
  var skipCache = /* @__PURE__ */ new Map();
  async function fetchSkipEvents(episodeId) {
    if (skipCache.has(episodeId)) return { ok: true, segments: skipCache.get(episodeId) };
    try {
      const res = await fetch(skipEventsUrl(episodeId), { credentials: "omit" });
      if (!res.ok) return { ok: false, segments: [], error: `HTTP ${res.status}` };
      const segments = parseSkipEvents(await res.json());
      skipCache.set(episodeId, segments);
      return { ok: true, segments };
    } catch (err) {
      return { ok: false, segments: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
  var metaKey = (tabId) => `tabMeta:${tabId}`;
  async function setTabMeta(tabId, meta) {
    await chrome.storage.session.set({ [metaKey(tabId)]: meta });
  }
  async function getTabMeta(tabId) {
    const key = metaKey(tabId);
    const stored = await chrome.storage.session.get(key);
    return stored[key] ?? null;
  }
  async function clearTabMeta(tabId) {
    await chrome.storage.session.remove(metaKey(tabId));
  }
  function toast(tabId, text) {
    void chrome.tabs.sendMessage(tabId, { type: "TRACKER_TOAST", text }).catch(() => {
    });
  }
  async function startMalAuth() {
    try {
      const redirectUri = chrome.identity.getRedirectURL();
      const verifier = randomVerifier();
      const state = randomVerifier().slice(0, 16);
      const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authorizeUrl(verifier, redirectUri, state),
        interactive: true
      });
      const params = new URLSearchParams((responseUrl ?? "").split("?")[1] ?? "");
      if (params.get("state") !== state) throw new Error("State mismatch");
      const code = params.get("code");
      if (!code) throw new Error(params.get("error") ?? "No authorization code");
      const token = await exchangeCode(code, verifier, redirectUri);
      await setTokenData(token);
      const name = await getUserName(token.access).catch(() => void 0);
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "error" };
    }
  }
  async function validAccessToken() {
    const data = await getTokenData();
    if (!data) return null;
    if (Date.now() < data.expiresAt - 6e4) return data.access;
    try {
      const fresh = await refresh(data.refresh);
      await setTokenData(fresh);
      return fresh.access;
    } catch {
      return null;
    }
  }
  function normalizeTitle(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function detectSeason(normalizedTitle, baseName) {
    const t = normalizedTitle;
    let m = t.match(/\bseason\s+(\d+)\b/) ?? t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
    if (m) return Number(m[1]);
    if (/\bfinal\s+season\b/.test(t)) return 99;
    if (/\biv\b/.test(t)) return 4;
    if (/\biii\b/.test(t)) return 3;
    if (/\bii\b/.test(t)) return 2;
    m = t.match(/\b(\d{1,2})\s*$/);
    if (m && !normalizeTitle(baseName).includes(m[1])) {
      const n = Number(m[1]);
      if (n >= 2 && n <= 20) return n;
    }
    return 1;
  }
  function titleSimilarity(q, t) {
    if (!q || !t) return 0;
    if (t === q) return 100;
    if (t.startsWith(q) || q.startsWith(t)) return 80;
    if (t.includes(q) || q.includes(t)) return 55;
    const qWords = new Set(q.split(" "));
    const tWords = t.split(" ");
    const overlap = tWords.filter((w) => qWords.has(w)).length;
    return overlap / Math.max(qWords.size, tWords.length) * 50;
  }
  function matchScore(seriesName, season, anime) {
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
    if (anime.mediaType === "tv") score += 6;
    score += candSeason === target ? 14 : -22;
    return score;
  }
  async function resolveMapping(access, meta) {
    const key = seriesKey(meta);
    const cached = await getMapping(key);
    if (cached && (cached.pinned || cached.v === RESOLVER_VERSION)) return cached;
    const base = meta.series.trim();
    const queries = [];
    const add = (q) => {
      const t = q.trim();
      if (t.length >= 3 && !queries.includes(t)) queries.push(t);
    };
    if (meta.season && meta.season > 1) add(`${base} ${meta.season}`);
    add(base);
    add(base.split(/\s*[:–—]\s*/)[0]);
    add(base.split(",")[0]);
    const words = base.split(/\s+/);
    if (words.length > 6) add(words.slice(0, 6).join(" "));
    if (words.length > 4) add(words.slice(0, 4).join(" "));
    let best = null;
    for (const q of queries) {
      const results = await searchAnime(access, q).catch(() => []);
      for (const r of results) {
        const score = matchScore(base, meta.season, r);
        if (!best || score > best.score) best = { anime: r, score };
      }
      if (best && best.score >= 80) break;
    }
    if (best) {
      const mapping = {
        mediaId: best.anime.id,
        title: best.anime.title || meta.series,
        episodes: best.anime.episodes,
        v: RESOLVER_VERSION
      };
      await setMapping(key, mapping);
      return mapping;
    }
    return null;
  }
  async function onEpisodeWatched(tabId, episodeId) {
    const log = (...a) => void 0;
    const settings = await getSettings();
    if (!settings.enabled || !settings.mal.enabled) {
      log("watched: ignored (extension or MAL sync disabled)");
      return;
    }
    const meta = await getTabMeta(tabId);
    if (!meta) {
      log("watched: no stored meta for tab", tabId, "(episode", episodeId + ")");
      return;
    }
    if (meta.episode == null) {
      log("watched: stored meta has no episode number", meta.series);
      return;
    }
    log("watched: syncing", `${meta.series} E${meta.episode}`, "(tab", tabId + ")");
    const access = await validAccessToken();
    if (!access) {
      log("watched: no MAL access token \u2014 not connected");
      toast(tabId, "Crunchy Companion: connect MyAnimeList in settings to sync progress");
      return;
    }
    try {
      const mapping = await resolveMapping(access, meta);
      if (!mapping) {
        log("watched: no MAL match for", meta.series);
        toast(tabId, `Crunchy Companion: couldn't find "${meta.series}" on MyAnimeList`);
        return;
      }
      const current = await getAnimeStatus(access, mapping.mediaId).catch(() => null);
      const total = mapping.episodes ?? current?.total ?? null;
      const watched = Math.max(current?.watched ?? 0, meta.episode);
      const patch = {
        num_watched_episodes: watched
      };
      if (current?.rewatching) {
      } else if (total != null && watched >= total) {
        patch.status = "completed";
      } else if (current?.status !== "completed") {
        patch.status = "watching";
      }
      log(
        "watched: pushing to MAL",
        `"${mapping.title}" (#${mapping.mediaId})`,
        `${current?.watched ?? 0} -> ${watched}`,
        patch.status ? `status=${patch.status}` : ""
      );
      await setMyListStatus(access, mapping.mediaId, patch);
      log("watched: MAL updated OK", `${mapping.title} \u2022 episode ${watched}`);
      toast(tabId, `MyAnimeList updated: ${mapping.title} \u2022 episode ${watched}`);
    } catch (err) {
      log("watched: MAL sync FAILED", err);
      toast(tabId, `Crunchy Companion: MAL sync failed (${err instanceof Error ? err.message : "error"})`);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case "FETCH_SKIP_EVENTS":
        fetchSkipEvents(message.episodeId).then(sendResponse);
        return true;
      case "EPISODE_META":
        if (sender.tab?.id != null) void setTabMeta(sender.tab.id, message.meta);
        return false;
      case "EPISODE_WATCHED":
        if (sender.tab?.id != null) void onEpisodeWatched(sender.tab.id, message.episodeId);
        return false;
      case "START_MAL_AUTH":
        startMalAuth().then(sendResponse);
        return true;
      case "GET_TAB_STATUS": {
        void (async () => {
          const meta = await getTabMeta(message.tabId);
          const segments = meta ? skipCache.get(meta.episodeId)?.length ?? 0 : 0;
          sendResponse({ meta, segments });
        })();
        return true;
      }
      case "GET_MAL_STATUS": {
        const meta = message.meta;
        (async () => {
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
            related: d.related
          });
        })().catch(() => sendResponse({ ok: false }));
        return true;
      }
      case "GET_MAL_CHARACTERS": {
        getCharacters(message.animeId).then((characters) => sendResponse({ ok: true, characters })).catch(() => sendResponse({ ok: false, characters: [] }));
        return true;
      }
      case "GET_MAL_REVIEWS": {
        getReviews(message.animeId).then(({ reviews, allUrl }) => sendResponse({ ok: true, reviews, allUrl })).catch(() => sendResponse({ ok: false, reviews: [] }));
        return true;
      }
      case "GET_MY_LIST": {
        (async () => {
          const access = await validAccessToken();
          if (!access) return sendResponse({ ok: false, connected: false, items: [] });
          const items = await getUserList(access, message.status).catch(() => []);
          sendResponse({ ok: true, connected: true, items });
        })().catch(() => sendResponse({ ok: false, connected: false, items: [] }));
        return true;
      }
      case "GET_SEASONAL": {
        getSeasonal().then((items) => sendResponse({ ok: true, items })).catch(() => sendResponse({ ok: false, items: [] }));
        return true;
      }
      case "SET_MAL_STATUS": {
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
            rewatchCount: s.rewatchCount
          });
        })().catch((err) => {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : "error" });
        });
        return true;
      }
      default:
        return false;
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => void clearTabMeta(tabId));
})();
