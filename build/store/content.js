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
  function onSettingsChanged(cb) {
    const listener = (changes, area) => {
      if (area !== "sync" || !(STORAGE_KEY in changes)) return;
      cb(withDefaults(changes[STORAGE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  // src/content/navigation.ts
  function matchWatch(url) {
    const match = url.match(/\/watch\/([^/?#]+)/);
    return match ? { episodeId: match[1], url } : null;
  }
  function parseEpisode(url = location.href) {
    return matchWatch(url) ?? (document.referrer ? matchWatch(document.referrer) : null);
  }
  var patched = false;
  function patchHistory(onChange) {
    if (patched) return;
    patched = true;
    const fire = () => window.dispatchEvent(new Event("crunchy-companion:locationchange"));
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function(...args) {
        const result = original.apply(this, args);
        fire();
        return result;
      };
    }
    window.addEventListener("crunchy-companion:locationchange", onChange);
  }
  function onEpisodeChange(handler) {
    let lastId = void 0;
    const check = () => {
      const ctx = parseEpisode();
      const id = ctx?.episodeId ?? null;
      if (id !== lastId) {
        lastId = id;
        handler(ctx);
      }
    };
    patchHistory(check);
    window.addEventListener("popstate", check);
    const pollId = window.setInterval(check, 1e3);
    check();
    return () => {
      window.removeEventListener("popstate", check);
      window.removeEventListener("crunchy-companion:locationchange", check);
      window.clearInterval(pollId);
    };
  }

  // src/content/player.ts
  function waitForVideo(onVideo, { timeoutMs = 3e4, intervalMs = 400 } = {}) {
    let cancelled = false;
    const existing = document.querySelector("video");
    if (existing) {
      onVideo(existing);
      return () => {
      };
    }
    const start = performance.now();
    const id = window.setInterval(() => {
      if (cancelled) return;
      const video = document.querySelector("video");
      if (video) {
        window.clearInterval(id);
        onVideo(video);
      } else if (performance.now() - start > timeoutMs) {
        window.clearInterval(id);
      }
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }
  function seekTo(video, time) {
    if (!Number.isFinite(time)) return;
    if (video.currentTime < time) {
      video.currentTime = time;
    }
  }

  // src/shared/runtime.ts
  function isExtensionContextValid() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  // src/shared/messages.ts
  function requestSkipEvents(episodeId) {
    if (!isExtensionContextValid()) return Promise.resolve({ ok: false, segments: [] });
    try {
      return chrome.runtime.sendMessage({
        type: "FETCH_SKIP_EVENTS",
        episodeId
      });
    } catch {
      return Promise.resolve({ ok: false, segments: [] });
    }
  }
  function fireAndForget(message) {
    if (!isExtensionContextValid()) return;
    try {
      void chrome.runtime.sendMessage(message).catch(() => {
      });
    } catch {
    }
  }
  function sendEpisodeMeta(meta) {
    fireAndForget({ type: "EPISODE_META", meta });
  }
  function sendEpisodeWatched(episodeId) {
    fireAndForget({ type: "EPISODE_WATCHED", episodeId });
  }

  // src/content/skip-api.ts
  var frameCache = /* @__PURE__ */ new Map();
  async function getSkipSegments(episodeId) {
    if (frameCache.has(episodeId)) return frameCache.get(episodeId);
    try {
      const res = await requestSkipEvents(episodeId);
      const segments = res.ok ? res.segments : [];
      frameCache.set(episodeId, segments);
      return segments;
    } catch {
      return [];
    }
  }

  // src/content/toast.ts
  var CONTAINER_ID = "crunchy-companion-toast-root";
  function ensureContainer() {
    let el = document.getElementById(CONTAINER_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = CONTAINER_ID;
    Object.assign(el.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      alignItems: "center",
      pointerEvents: "none"
    });
    document.documentElement.appendChild(el);
    return el;
  }
  function showToast({
    message,
    actionLabel,
    onAction,
    durationMs = 5e3
  }) {
    const container = ensureContainer();
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      pointerEvents: "auto",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      background: "rgba(20, 20, 24, 0.95)",
      color: "#fff",
      font: "500 13px/1.2 'Lato', system-ui, sans-serif",
      padding: "10px 14px",
      borderRadius: "8px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      border: "1px solid rgba(255,255,255,0.08)",
      opacity: "0",
      transition: "opacity 0.2s ease, transform 0.2s ease",
      transform: "translateY(8px)"
    });
    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);
    let timer;
    const dismiss = () => {
      if (timer) window.clearTimeout(timer);
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
      window.setTimeout(() => toast.remove(), 200);
    };
    if (actionLabel && onAction) {
      const btn = document.createElement("button");
      btn.textContent = actionLabel;
      Object.assign(btn.style, {
        cursor: "pointer",
        background: "#f47521",
        // Crunchyroll orange
        color: "#fff",
        border: "none",
        borderRadius: "5px",
        padding: "5px 10px",
        font: "700 12px/1 'Lato', system-ui, sans-serif"
      });
      btn.addEventListener("click", () => {
        onAction();
        dismiss();
      });
      toast.appendChild(btn);
    }
    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });
    timer = window.setTimeout(dismiss, durationMs);
  }

  // src/shared/stats.ts
  var KEY = "stats";
  var DAY_MS = 864e5;
  function dayKey(ts = Date.now()) {
    return new Date(ts).toISOString().slice(0, 10);
  }
  async function getStats() {
    const r = await chrome.storage.local.get(KEY);
    return r[KEY] ?? { skips: 0, secondsSaved: 0 };
  }
  async function bumpSkip(seconds = 0) {
    if (!isExtensionContextValid()) return;
    try {
      const s = await getStats();
      s.skips += 1;
      s.secondsSaved += Math.max(0, Math.round(seconds));
      const days = s.days ?? {};
      const today = dayKey();
      days[today] = (days[today] ?? 0) + 1;
      const cutoff = dayKey(Date.now() - 21 * DAY_MS);
      for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
      s.days = days;
      await chrome.storage.local.set({ [KEY]: s });
    } catch {
    }
  }

  // src/shared/log.ts
  function log(...args) {
  }

  // src/shared/types.ts
  var SKIP_LABELS = {
    intro: "Intro",
    recap: "Recap",
    credits: "Outro",
    preview: "Preview"
  };

  // src/content/skip-engine.ts
  function attachSkipEngine(video, segments, getSettings2) {
    if (segments.length === 0) {
      return { detach: () => {
      } };
    }
    const consumed = /* @__PURE__ */ new Set();
    const ENTER_EPS = 0.5;
    const onTimeUpdate = () => {
      const settings2 = getSettings2();
      if (!settings2.enabled || settings2.mode !== "seek") return;
      const t = video.currentTime;
      for (const seg of segments) {
        if (consumed.has(seg)) continue;
        if (!settings2.skip[seg.type]) continue;
        if (t + ENTER_EPS >= seg.start && t < seg.end) {
          consumed.add(seg);
          const from = t;
          log(
            "seek-skip",
            seg.type,
            `${seg.start.toFixed(1)}\u2192${seg.end.toFixed(1)}s (at ${from.toFixed(1)}s)`
          );
          seekTo(video, seg.end);
          void bumpSkip(seg.end - from);
          if (settings2.showToast) {
            showToast({
              message: `Skipped ${SKIP_LABELS[seg.type].toLowerCase()}`,
              actionLabel: "Undo",
              onAction: () => {
                video.currentTime = from;
              }
            });
          }
          break;
        }
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return {
      detach: () => video.removeEventListener("timeupdate", onTimeUpdate)
    };
  }

  // src/content/dom-skip.ts
  var SKIP_TEXT = /\bskip\b/i;
  var TESTID_SELECTOR = '[data-testid="skipIntroText"], [data-testid="overlay-cta"], [data-testid*="skip" i]';
  function matchesSkip(el) {
    const aria = el.getAttribute("aria-label") ?? "";
    const title = el.getAttribute("title") ?? "";
    const text = (el.textContent ?? "").trim();
    return SKIP_TEXT.test(aria) || SKIP_TEXT.test(title) || SKIP_TEXT.test(text);
  }
  function findSkipButtons(root) {
    const out = [];
    for (const el of root.querySelectorAll(TESTID_SELECTOR)) {
      out.push(el);
    }
    for (const el of root.querySelectorAll(
      'button, [role="button"], a'
    )) {
      if (matchesSkip(el)) out.push(el);
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) out.push(...findSkipButtons(el.shadowRoot));
    }
    return out;
  }
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }
  function startDomSkip(enabled) {
    const tryClick = () => {
      if (!enabled()) return;
      for (const btn of findSkipButtons(document)) {
        if (typeof btn.click !== "function" || !isVisible(btn)) continue;
        log("clicking native skip button:", (btn.textContent ?? "").trim().slice(0, 30));
        btn.click();
        void bumpSkip(0);
        break;
      }
    };
    const observer = new MutationObserver(() => tryClick());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-label", "data-testid"]
    });
    tryClick();
    return { stop: () => observer.disconnect() };
  }

  // src/content/autonext.ts
  var NEXT_TEXT = /\b(next episode|up next|play next)\b/i;
  function findNextButton() {
    const candidates = document.querySelectorAll(
      '[data-testid*="next" i], button, [role="button"], a'
    );
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") ?? "") + " " + (el.getAttribute("title") ?? "") + " " + (el.textContent ?? "");
      if (NEXT_TEXT.test(label)) return el;
    }
    return null;
  }
  function attachAutoNext(video, enabled) {
    let tries = 0;
    let pollId;
    const stopPolling = () => {
      if (pollId !== void 0) {
        window.clearInterval(pollId);
        pollId = void 0;
      }
    };
    const onEnded = () => {
      if (!enabled()) return;
      tries = 0;
      stopPolling();
      pollId = window.setInterval(() => {
        tries += 1;
        const btn = findNextButton();
        if (btn) {
          btn.click();
          stopPolling();
        } else if (tries > 20) {
          stopPolling();
        }
      }, 300);
    };
    video.addEventListener("ended", onEnded);
    return {
      detach: () => {
        video.removeEventListener("ended", onEnded);
        stopPolling();
      }
    };
  }

  // src/content/progress.ts
  var STARTED_SECONDS = 30;
  function attachProgress(video, episodeId, enabled) {
    let fired = false;
    const onTimeUpdate = () => {
      if (fired || !enabled()) return;
      const { currentTime, duration } = video;
      if (!Number.isFinite(duration) || duration <= 0) return;
      if (currentTime >= STARTED_SECONDS) {
        fired = true;
        log("episode started -> updating tracker to this episode", episodeId);
        sendEpisodeWatched(episodeId);
      }
    };
    const onNewMedia = () => {
      fired = false;
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadstart", onNewMedia);
    video.addEventListener("emptied", onNewMedia);
    return {
      detach: () => {
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("loadstart", onNewMedia);
        video.removeEventListener("emptied", onNewMedia);
      }
    };
  }

  // src/content/meta.ts
  function coerceImage(img) {
    if (typeof img === "string") return img;
    if (Array.isArray(img)) return coerceImage(img[0]);
    if (img && typeof img === "object") return String(img.url ?? "");
    return "";
  }
  function fromJsonLd() {
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(el.textContent ?? "");
        if (data?.["@type"] === "TVEpisode") {
          return {
            series: data.partOfSeries?.name ?? "",
            season: data.partOfSeason?.seasonNumber ? Number(data.partOfSeason.seasonNumber) : null,
            episode: data.episodeNumber ? Number(data.episodeNumber) : null,
            episodeTitle: data.name ?? "",
            thumbnail: coerceImage(data.image ?? data.thumbnailUrl),
            // The watch URL this block describes. Crunchyroll bakes the JSON-LD at
            // page load and does NOT refresh it on SPA auto-advance, so comparing
            // this against the current episode id tells us if it's gone stale.
            sourceUrl: typeof data.url === "string" ? data.url : ""
          };
        }
      } catch {
      }
    }
    return null;
  }
  function parseEpSeason(text) {
    const ep = text.match(/\bepisode\s*(\d+)/i) ?? text.match(/\bE\s*(\d+)\b/);
    const se = text.match(/\bseason\s*(\d+)/i) ?? text.match(/\bS\s*(\d+)\b/);
    return {
      episode: ep ? Number(ep[1]) : null,
      season: se ? Number(se[1]) : null
    };
  }
  function fromOgTitle() {
    const og = document.querySelector('meta[property="og:title"]')?.content ?? "";
    return parseEpSeason(og);
  }
  function fromDocTitle() {
    return parseEpSeason(document.title);
  }
  function ogImage() {
    return document.querySelector('meta[property="og:image"]')?.content ?? "";
  }
  function textOf(testid) {
    return (document.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "").trim();
  }
  function fromTestIds() {
    const epRaw = textOf("current-media-episode-number");
    const epMatch = epRaw.match(/E\s*(\d+)/i);
    const seasonMatch = epRaw.match(/S\s*(\d+)/i);
    return {
      series: textOf("current-media-parent-title"),
      episode: epMatch ? Number(epMatch[1]) : null,
      season: seasonMatch ? Number(seasonMatch[1]) : null,
      episodeTitle: textOf("current-media-title")
    };
  }
  var SMALL_WORDS = /* @__PURE__ */ new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "nor",
    "of",
    "to",
    "in",
    "on",
    "at",
    "for",
    "with",
    "as",
    "by",
    "from",
    "vs"
  ]);
  function titleCase(slug) {
    return slug.split("-").filter(Boolean).map(
      (w, i) => i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)
    ).join(" ");
  }
  function fromUrlSlug() {
    const m = location.pathname.match(/\/watch\/[^/]+\/([^/?#]+)/);
    return m ? titleCase(m[1]) : "";
  }
  function pickEpisodeTitle(series, ...candidates) {
    const s = series.trim().toLowerCase();
    for (const c of candidates) {
      const t = (c ?? "").trim();
      if (t && !t.toLowerCase().startsWith(s)) return t;
    }
    return "";
  }
  function extractMeta(episodeId) {
    const ld = fromJsonLd();
    const ids = fromTestIds();
    const og = fromOgTitle();
    const title = fromDocTitle();
    const series = ld?.series || ids.series || "";
    if (!series) return null;
    const ldFresh = ld ? !ld.sourceUrl || ld.sourceUrl.includes(episodeId) : false;
    const ldEpisode = ldFresh ? ld?.episode ?? null : null;
    const ldSeason = ldFresh ? ld?.season ?? null : null;
    return {
      episodeId,
      series,
      // A JSON-LD block whose url matches THIS episode is the authoritative
      // source for the numbers (the `current-media-*` testids no longer exist in
      // the watch DOM). When it's stale (url points at the previous episode after
      // an SPA auto-advance) we drop it and fall back to og:title — which carries
      // an explicit "E<n>" and stays in sync with the current episode — then the
      // testid / page title; `captureEpisode` keeps polling until one is fresh.
      season: ldSeason ?? og.season ?? ids.season ?? title.season ?? null,
      episode: ldEpisode ?? og.episode ?? ids.episode ?? title.episode ?? null,
      episodeTitle: pickEpisodeTitle(
        series,
        ldFresh ? ld?.episodeTitle : "",
        ids.episodeTitle,
        fromUrlSlug()
      ),
      thumbnail: ld?.thumbnail || ogImage()
    };
  }

  // src/content/keep-watching.ts
  var RESUME = /(keep watching|continue watching|still watching|are you still|i'?m still (?:here|watching)|yes,?\s*i'?m\s*(?:still\s*)?watching|resume playback)/i;
  var PROFILE_HEADING = /who(?:'s| is)? watching|(?:select|choose|pick)\s+(?:a\s+)?profile/i;
  function isVisible2(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }
  function labelOf(el) {
    return `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`.trim();
  }
  function dismissStillWatching() {
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      if (isVisible2(el) && RESUME.test(labelOf(el))) {
        log("keep-watching: dismissing prompt \u2192", labelOf(el).slice(0, 40));
        el.click();
        return true;
      }
    }
    return false;
  }
  function dismissProfilePicker() {
    const headingShown = Array.from(
      document.querySelectorAll('h1, h2, h3, [role="heading"]')
    ).some((h) => PROFILE_HEADING.test(h.textContent ?? ""));
    if (!headingShown) return false;
    const tiles = document.querySelectorAll(
      '[data-testid*="profile" i], [aria-label*="profile" i], a[href*="profile" i], [class*="profile" i] button'
    );
    for (const el of tiles) {
      if (isVisible2(el)) {
        log("keep-watching: selecting profile to resume playback");
        el.click();
        return true;
      }
    }
    log("keep-watching: profile picker detected but no tile matched (needs tuning)");
    return false;
  }
  function startKeepWatching(enabled) {
    const tick = () => {
      if (!enabled()) return;
      if (dismissStillWatching()) return;
      dismissProfilePicker();
    };
    const observer = new MutationObserver(() => tick());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const interval = window.setInterval(tick, 2e3);
    tick();
    return {
      stop: () => {
        observer.disconnect();
        window.clearInterval(interval);
      }
    };
  }

  // src/shared/history.ts
  var KEY2 = "history";
  var MAX = 30;
  async function recordHistory(entry) {
    if (!entry.series) return;
    if (!isExtensionContextValid()) return;
    try {
      const r = await chrome.storage.local.get(KEY2);
      const list = r[KEY2] ?? [];
      const key = entry.series.trim().toLowerCase();
      const next = [
        { ...entry, updatedAt: Date.now() },
        ...list.filter((e) => e.series.trim().toLowerCase() !== key)
      ].slice(0, MAX);
      await chrome.storage.local.set({ [KEY2]: next });
    } catch {
    }
  }

  // src/content/index.ts
  log("content script loaded in", location.href);
  var isTopWatch = () => /\/watch\//.test(location.href);
  chrome.runtime.onMessage.addListener(
    (msg, _sender, sendResponse) => {
      if (msg?.type === "TRACKER_TOAST" && isTopWatch() && msg.text) {
        showToast({ message: msg.text, durationMs: 4e3 });
        return false;
      }
      if (msg?.type === "GET_STATUS") {
        if (!isTopWatch()) return false;
        const ctx = parseEpisode();
        if (!ctx) {
          sendResponse({ meta: null, segments: 0 });
          return true;
        }
        const meta = extractMeta(ctx.episodeId);
        requestSkipEvents(ctx.episodeId).then((r) => sendResponse({ meta, segments: r.ok ? r.segments.length : 0 })).catch(() => sendResponse({ meta, segments: 0 }));
        return true;
      }
      return false;
    }
  );
  var settings = DEFAULT_SETTINGS;
  getSettings().then((s) => settings = s).catch(() => {
  });
  onSettingsChanged((s) => settings = s);
  startKeepWatching(() => settings.enabled && settings.keepWatching);
  var teardown = [];
  function teardownSession() {
    for (const fn of teardown) {
      try {
        fn();
      } catch {
      }
    }
    teardown = [];
  }
  function captureEpisode(ctx) {
    let tries = 0;
    let lastKey = "";
    const attempt = () => {
      if (parseEpisode()?.episodeId !== ctx.episodeId) return;
      const meta = extractMeta(ctx.episodeId);
      if (meta) {
        const key = `${meta.season}|${meta.episode}|${meta.episodeTitle}`;
        if (key !== lastKey) {
          lastKey = key;
          log("episode meta", `${meta.series} S${meta.season} E${meta.episode}`);
          sendEpisodeMeta(meta);
          void recordHistory({
            episodeId: meta.episodeId,
            url: ctx.url,
            series: meta.series,
            episodeTitle: meta.episodeTitle,
            episode: meta.episode,
            season: meta.season,
            thumbnail: meta.thumbnail
          });
        }
      }
      if (++tries < 20) window.setTimeout(attempt, 600);
    };
    attempt();
  }
  function startSession(ctx) {
    teardownSession();
    if (isTopWatch() && ctx) captureEpisode(ctx);
    const cancelWait = waitForVideo(async (video) => {
      const segments = ctx ? await getSkipSegments(ctx.episodeId) : [];
      log(
        "video ready.",
        ctx ? `episode=${ctx.episodeId}` : "no episode id (iframe)",
        `skip segments=${segments.length}`,
        segments.length ? `[${segments.map((s) => s.type).join(", ")}]` : "",
        `mode=${settings.mode} enabled=${settings.enabled}`,
        `skip=${Object.entries(settings.skip).filter(([, on]) => on).map(([k]) => k).join("/")}`
      );
      const apiActive = () => settings.mode === "seek" && segments.length > 0;
      if (segments.length > 0) {
        teardown.push(attachSkipEngine(video, segments, () => settings).detach);
      }
      teardown.push(
        startDomSkip(
          () => settings.enabled && (settings.mode === "click" || !apiActive())
        ).stop
      );
      teardown.push(
        attachAutoNext(video, () => settings.enabled && settings.autoNext).detach
      );
      if (ctx) {
        teardown.push(
          attachProgress(
            video,
            ctx.episodeId,
            () => settings.enabled && settings.mal.enabled
          ).detach
        );
      }
    });
    teardown.push(cancelWait);
  }
  var unsubscribeNav = onEpisodeChange(startSession);
  var orphanWatch = window.setInterval(() => {
    if (isExtensionContextValid()) return;
    window.clearInterval(orphanWatch);
    teardownSession();
    unsubscribeNav();
    log("extension context invalidated \u2014 content script stopped (reload the tab)");
  }, 1e3);
})();
