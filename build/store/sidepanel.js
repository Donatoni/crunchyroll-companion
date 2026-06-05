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
  async function saveSettings(settings2) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: settings2 });
  }
  async function patchSettings(patch) {
    const next = withDefaults({ ...await getSettings(), ...patch });
    await saveSettings(next);
    return next;
  }
  function onSettingsChanged(cb) {
    const listener = (changes, area) => {
      if (area !== "sync" || !(STORAGE_KEY in changes)) return;
      cb(withDefaults(changes[STORAGE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  // src/shared/messages.ts
  function requestMalStatus(meta) {
    return chrome.runtime.sendMessage({
      type: "GET_MAL_STATUS",
      meta
    });
  }
  function setMalStatus(meta, patch) {
    return chrome.runtime.sendMessage({
      type: "SET_MAL_STATUS",
      meta,
      patch
    });
  }
  function startMalAuth() {
    return chrome.runtime.sendMessage({
      type: "START_MAL_AUTH"
    });
  }
  function requestMalCharacters(animeId) {
    return chrome.runtime.sendMessage({
      type: "GET_MAL_CHARACTERS",
      animeId
    });
  }
  function requestMalReviews(animeId) {
    return chrome.runtime.sendMessage({
      type: "GET_MAL_REVIEWS",
      animeId
    });
  }
  function requestMyList(status) {
    return chrome.runtime.sendMessage({
      type: "GET_MY_LIST",
      status
    });
  }
  function requestSeasonal() {
    return chrome.runtime.sendMessage({
      type: "GET_SEASONAL"
    });
  }

  // src/shared/mal.ts
  var API = "https://api.myanimelist.net/v2";
  async function getUserName(access) {
    const res = await fetch(`${API}/users/@me?fields=name`, {
      headers: { Authorization: `Bearer ${access}` }
    });
    if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
    return (await res.json()).name;
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
  function lastNDays(stats, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(stats.days?.[dayKey(Date.now() - i * DAY_MS)] ?? 0);
    return out;
  }
  function formatSaved(seconds) {
    const m = Math.round(seconds / 60);
    if (m < 60) return `~${m}m`;
    return `~${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // src/shared/history.ts
  var KEY2 = "history";
  async function getHistory() {
    const r = await chrome.storage.local.get(KEY2);
    const list = r[KEY2] ?? [];
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function removeHistory(series) {
    const r = await chrome.storage.local.get(KEY2);
    const list = r[KEY2] ?? [];
    const key = series.trim().toLowerCase();
    await chrome.storage.local.set({
      [KEY2]: list.filter((e) => e.series.trim().toLowerCase() !== key)
    });
  }
  async function clearHistory() {
    await chrome.storage.local.remove(KEY2);
  }

  // src/shared/tracker-store.ts
  var TOKEN_KEY = "mal_token";
  var MAP_KEY = "mal_mappings";
  async function getTokenData() {
    const r = await chrome.storage.local.get(TOKEN_KEY);
    return r[TOKEN_KEY] ?? null;
  }
  async function clearToken() {
    await chrome.storage.local.remove(TOKEN_KEY);
  }
  async function getMappings() {
    const r = await chrome.storage.local.get(MAP_KEY);
    return r[MAP_KEY] ?? {};
  }
  async function setMapping(key, value) {
    const all = await getMappings();
    all[key] = value;
    await chrome.storage.local.set({ [MAP_KEY]: all });
  }
  async function removeMapping(key) {
    const all = await getMappings();
    delete all[key];
    await chrome.storage.local.set({ [MAP_KEY]: all });
  }

  // src/sidepanel/sidepanel.ts
  var $ = (sel) => document.querySelector(sel);
  var esc = (v) => String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
  var MAL_STATUS = [
    { value: "watching", label: "Watching", dot: "#3aa0ff" },
    { value: "completed", label: "Completed", dot: "#34d27b" },
    { value: "on_hold", label: "On hold", dot: "#f0b429" },
    { value: "dropped", label: "Dropped", dot: "#f0596b" },
    { value: "plan_to_watch", label: "Plan to watch", dot: "#9b9ba3" }
  ];
  var SKIP_SEGMENTS = ["intro", "recap", "credits", "preview"];
  var settings = null;
  var currentMeta = null;
  var malResp;
  var malTotal = null;
  var lastMetaKey = "";
  var lastCharId = null;
  var charCache = /* @__PURE__ */ new Map();
  var lastReviewId = null;
  var reviewCache = /* @__PURE__ */ new Map();
  var watchingView = $("#watchingView");
  var idleView = $("#idleView");
  var heroBg = $("#heroBg");
  var poster = $("#poster");
  var heroTitle = $("#heroTitle");
  var heroSE = $("#heroSE");
  var heroEpTitle = $("#heroEpTitle");
  var metaStrip = $("#metaStrip");
  var genresEl = $("#genres");
  var synopsisWrap = $("#synopsisWrap");
  var synopsisEl = $("#synopsis");
  var synMore = $("#synMore");
  var malSynced = $("#malSynced");
  var malCard = $("#malCard");
  var malNudge = $("#malNudge");
  var malNote = $("#malNote");
  var malErr = $("#malErr");
  var progNow = $("#progNow");
  var progTotal = $("#progTotal");
  var progPct = $("#progPct");
  var progBar = $("#progBar");
  var epVal = $("#epVal");
  var epMinus = $("#epMinus");
  var epPlus = $("#epPlus");
  var statusBtn = $("#statusBtn");
  var statusMenu = $("#statusMenu");
  var statusLabel = $("#statusLabel");
  var statusDot = $("#statusDot");
  var scoreBtn = $("#scoreBtn");
  var scoreMenu = $("#scoreMenu");
  var malLink = $("#malLink");
  var seasonsSection = $("#seasonsSection");
  var seasonsRail = $("#seasonsRail");
  var charactersSection = $("#charactersSection");
  var charactersRail = $("#charactersRail");
  var reviewsSection = $("#reviewsSection");
  var reviewsList = $("#reviewsList");
  var idleHistorySection = $("#idleHistorySection");
  var idleHistory = $("#idleHistory");
  var runTime = $("#runTime");
  var runDesc = $("#runDesc");
  var runBars = $("#runBars");
  var runTotal = $("#runTotal");
  var runSegments = $("#runSegments");
  var runShows = $("#runShows");
  var resumeCard = $("#resumeCard");
  var resumeThumb = $("#resumeThumb");
  var resumeTitle = $("#resumeTitle");
  var resumeSub = $("#resumeSub");
  var myListSection = $("#myListSection");
  var myListRail = $("#myListRail");
  var seasonalSection = $("#seasonalSection");
  var seasonalRail = $("#seasonalRail");
  function metaKey(m) {
    return `${m.series}|${m.season}|${m.episode}`;
  }
  function setBg(el, url) {
    el.style.backgroundImage = url ? `url("${url}")` : "";
  }
  function renderHero() {
    if (!currentMeta) return;
    setBg(heroBg, currentMeta.thumbnail);
    setBg(poster, malResp ? malResp.picture || currentMeta.thumbnail : null);
    heroTitle.textContent = currentMeta.series;
    const se = [
      currentMeta.season ? `S${currentMeta.season}` : null,
      currentMeta.episode ? `E${currentMeta.episode}` : null
    ].filter(Boolean).join(" \xB7 ");
    heroSE.textContent = se;
    heroSE.hidden = !se;
    heroEpTitle.textContent = currentMeta.episodeTitle ? ` ${currentMeta.episodeTitle}` : "";
  }
  function hideDetails() {
    metaStrip.hidden = true;
    genresEl.hidden = true;
    synopsisWrap.hidden = true;
    seasonsSection.hidden = true;
  }
  function renderDetails(r) {
    const bits = [];
    const stat = (html) => {
      const s = document.createElement("span");
      s.className = "stat";
      s.innerHTML = html;
      return s;
    };
    if (r.mean) bits.push(stat(`<span class="star">\u2605</span><b>${r.mean.toFixed(2)}</b>`));
    if (r.mediaType) bits.push(stat(esc(r.mediaType.toUpperCase())));
    if (r.total) bits.push(stat(`<b>${esc(r.total)}</b>&nbsp;eps`));
    if (r.year) bits.push(stat(esc(r.year)));
    if (r.studios && r.studios.length) bits.push(stat(esc(r.studios[0])));
    metaStrip.replaceChildren();
    bits.forEach((b, i) => {
      if (i) {
        const sep = document.createElement("span");
        sep.className = "dot-sep";
        metaStrip.appendChild(sep);
      }
      metaStrip.appendChild(b);
    });
    metaStrip.hidden = bits.length === 0;
    genresEl.replaceChildren();
    for (const g of r.genres ?? []) {
      const el = document.createElement("span");
      el.className = "genre";
      el.textContent = g;
      genresEl.appendChild(el);
    }
    genresEl.hidden = !(r.genres && r.genres.length);
    const syn = (r.synopsis ?? "").trim();
    synopsisEl.textContent = syn;
    synopsisEl.classList.add("clamp");
    synMore.textContent = "Read more";
    synopsisWrap.hidden = !syn;
    renderSeasons(r.related ?? []);
  }
  synMore.addEventListener("click", () => {
    const clamped = synopsisEl.classList.toggle("clamp");
    synMore.textContent = clamped ? "Read more" : "Show less";
  });
  function renderSeasons(related) {
    const items = related.filter((r) => r.title);
    seasonsRail.replaceChildren();
    if (currentMeta && malResp?.animeId && malResp.title) {
      const cur = document.createElement("div");
      cur.className = "season cur";
      cur.innerHTML = `<div class="ph"></div><div class="t"></div><div class="n">${malResp.mediaType ? esc(malResp.mediaType.toUpperCase()) : ""}${malResp.total ? " \xB7 " + esc(malResp.total) : ""}</div>`;
      setBg(cur.querySelector(".ph"), malResp.picture);
      cur.querySelector(".t").textContent = malResp.title;
      seasonsRail.appendChild(cur);
    }
    for (const r of items) {
      const el = document.createElement("div");
      el.className = "season";
      el.innerHTML = `<div class="ph"></div><div class="t"></div><div class="n">${esc(r.relation || (r.mediaType ?? ""))}</div>`;
      setBg(el.querySelector(".ph"), r.picture);
      el.querySelector(".t").textContent = r.title;
      el.title = `${r.title}${r.relation ? " \u2014 " + r.relation : ""}`;
      el.addEventListener("click", () => {
        window.open(`https://myanimelist.net/anime/${r.id}`, "_blank", "noopener");
      });
      seasonsRail.appendChild(el);
    }
    seasonsSection.hidden = seasonsRail.children.length === 0;
  }
  async function loadCharacters(animeId) {
    if (animeId === lastCharId) return;
    lastCharId = animeId;
    charactersSection.hidden = true;
    let chars = charCache.get(animeId);
    if (!chars) {
      try {
        const r = await requestMalCharacters(animeId);
        chars = r.ok ? r.characters : [];
        charCache.set(animeId, chars);
      } catch {
        chars = [];
      }
    }
    if (animeId !== lastCharId) return;
    charactersRail.replaceChildren();
    for (const c of chars) {
      const el = document.createElement("div");
      el.className = "char";
      el.innerHTML = `<div class="av"></div><div class="cn"></div><div class="cr">${(c.role || "").toUpperCase()}</div>`;
      setBg(el.querySelector(".av"), c.image);
      el.querySelector(".cn").textContent = c.name;
      charactersRail.appendChild(el);
    }
    charactersSection.hidden = chars.length === 0;
  }
  function reviewTagClass(tag) {
    const t = tag.toLowerCase();
    if (t.includes("not")) return "not";
    if (t.includes("mixed")) return "mixed";
    if (t.includes("recommend")) return "rec";
    return "";
  }
  async function loadReviews(animeId) {
    if (animeId === lastReviewId) return;
    lastReviewId = animeId;
    reviewsSection.hidden = true;
    let data = reviewCache.get(animeId);
    if (!data) {
      try {
        const r = await requestMalReviews(animeId);
        data = { reviews: r.ok ? r.reviews : [], allUrl: r.allUrl ?? "" };
        reviewCache.set(animeId, data);
      } catch {
        data = { reviews: [], allUrl: "" };
      }
    }
    if (animeId !== lastReviewId) return;
    reviewsList.replaceChildren();
    for (const rv of data.reviews) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "review";
      const tagCls = reviewTagClass(rv.tag);
      const top = document.createElement("div");
      top.className = "review-top";
      top.innerHTML = `<div class="review-av"></div><span class="review-user"></span>` + (rv.score ? `<span class="review-score"><span style="color:#ffc24b">\u2605</span>${esc(rv.score)}</span>` : "") + (rv.tag ? `<span class="review-tag ${tagCls}">${esc(rv.tag)}</span>` : "");
      setBg(top.querySelector(".review-av"), rv.avatar);
      top.querySelector(".review-user").textContent = rv.user;
      const text = document.createElement("div");
      text.className = "review-text";
      text.textContent = rv.text;
      const more = document.createElement("div");
      more.className = "review-more";
      more.textContent = "Read full review \u2192";
      card.append(top, text, more);
      if (rv.url) card.addEventListener("click", () => window.open(rv.url, "_blank", "noopener"));
      reviewsList.appendChild(card);
    }
    if (data.reviews.length && data.allUrl) {
      const all = document.createElement("a");
      all.className = "reviews-all";
      all.href = data.allUrl;
      all.target = "_blank";
      all.rel = "noopener";
      all.textContent = "View all reviews on MyAnimeList \u2192";
      reviewsList.appendChild(all);
    }
    reviewsSection.hidden = data.reviews.length === 0;
  }
  function setStatusControl(value) {
    const opt = MAL_STATUS.find((o) => o.value === value) ?? MAL_STATUS[0];
    statusLabel.textContent = opt.label;
    statusDot.style.background = opt.dot;
    for (const el of statusMenu.querySelectorAll(".dd-opt")) {
      el.classList.toggle("sel", el.dataset.value === opt.value);
    }
  }
  function setScoreControl(value) {
    scoreBtn.replaceChildren();
    const row = document.createElement("span");
    row.className = "star-row";
    for (let i = 1; i <= 5; i++) {
      const fill = Math.max(0, Math.min(1, value / 2 - (i - 1)));
      const s = document.createElement("span");
      s.className = "s";
      s.textContent = "\u2605";
      const f = document.createElement("span");
      f.className = "fill";
      f.textContent = "\u2605";
      f.style.width = `${fill * 100}%`;
      s.appendChild(f);
      row.appendChild(s);
    }
    const num = document.createElement("span");
    num.className = "score-num";
    num.innerHTML = value ? `${value}<span class="max">/10</span>` : "\u2013";
    scoreBtn.append(row, num);
    for (const el of scoreMenu.querySelectorAll(".score-cell")) {
      el.classList.toggle("sel", Number(el.dataset.score) === value);
    }
  }
  function applyMal(r) {
    malResp = r;
    malErr.hidden = true;
    const matched = !!r?.ok;
    if (matched && r) {
      renderHero();
      renderDetails(r);
      if (r.animeId) {
        malLink.href = `https://myanimelist.net/anime/${r.animeId}`;
        void loadCharacters(r.animeId);
        void loadReviews(r.animeId);
      }
    } else {
      hideDetails();
      charactersSection.hidden = true;
      reviewsSection.hidden = true;
    }
    if (matched && r?.connected) {
      malNudge.hidden = true;
      malNote.hidden = true;
      malSynced.hidden = false;
      malCard.hidden = false;
      malTotal = r.total ?? null;
      const watched = r.watched ?? 0;
      progNow.textContent = String(watched);
      progTotal.textContent = r.total ? `/ ${r.total} episodes` : "episodes";
      const pct = r.total ? Math.round(watched / r.total * 100) : 0;
      progBar.style.width = `${Math.min(100, pct)}%`;
      progPct.textContent = r.total ? `${pct}%` : "";
      epVal.textContent = String(watched);
      epMinus.disabled = watched <= 0;
      epPlus.disabled = malTotal != null && watched >= malTotal;
      setStatusControl(r.status ?? "watching");
      setScoreControl(r.score ?? 0);
    } else if (!r?.connected) {
      malCard.hidden = true;
      malNote.hidden = true;
      malSynced.hidden = true;
      malNudge.hidden = false;
    } else {
      malCard.hidden = true;
      malNudge.hidden = true;
      malSynced.hidden = true;
      malNote.hidden = false;
      malNote.textContent = "Couldn't match this show on MyAnimeList yet.";
    }
  }
  async function loadMal() {
    if (!currentMeta) return;
    try {
      applyMal(await requestMalStatus(currentMeta));
    } catch {
      applyMal({ ok: false, connected: false });
    }
  }
  async function saveMal(patch) {
    if (!currentMeta) return;
    malErr.hidden = true;
    malCard.style.opacity = "0.5";
    try {
      const r = await setMalStatus(currentMeta, patch);
      if (r?.ok) {
        applyMal({ ...malResp, ...r });
      } else {
        malErr.textContent = r?.error ? `Couldn't save: ${r.error}` : "Couldn't save to MAL";
        malErr.hidden = false;
      }
    } catch {
      malErr.textContent = "Couldn't reach MAL";
      malErr.hidden = false;
    } finally {
      malCard.style.opacity = "1";
    }
  }
  epMinus.addEventListener("click", () => {
    const cur = Number(epVal.textContent) || 0;
    if (cur > 0) void saveMal({ num_watched_episodes: cur - 1 });
  });
  epPlus.addEventListener("click", () => {
    const cur = Number(epVal.textContent) || 0;
    const n = cur + 1;
    const patch = { num_watched_episodes: n };
    if (malTotal && n >= malTotal) patch.status = "completed";
    void saveMal(patch);
  });
  epVal.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      epVal.blur();
    } else if (e.key === "Escape") {
      epVal.textContent = String(malResp?.watched ?? 0);
      epVal.blur();
    }
  });
  epVal.addEventListener("focus", () => {
    const range = document.createRange();
    range.selectNodeContents(epVal);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  epVal.addEventListener("blur", () => {
    const cur = malResp?.watched ?? 0;
    const raw = (epVal.textContent || "").replace(/[^0-9]/g, "");
    let n = raw === "" ? cur : parseInt(raw, 10);
    if (malTotal != null) n = Math.min(n, malTotal);
    n = Math.max(0, n);
    epVal.textContent = String(n);
    if (n !== cur) {
      const patch = { num_watched_episodes: n };
      if (malTotal && n >= malTotal) patch.status = "completed";
      void saveMal(patch);
    }
  });
  for (const o of MAL_STATUS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dd-opt";
    b.dataset.value = o.value;
    b.innerHTML = `<span class="dd-dot" style="background:${o.dot}"></span>${o.label}<svg class="check" width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5 9-10" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round"/></svg>`;
    b.addEventListener("click", () => {
      closeMenus();
      const patch = { status: o.value };
      if (o.value === "completed" && malTotal) {
        patch.num_watched_episodes = malTotal;
      } else if (o.value === "watching") {
        const ep = currentMeta?.episode;
        if (ep && ep > 0) {
          patch.num_watched_episodes = ep;
          patch.is_rewatching = false;
        }
      }
      void saveMal(patch);
    });
    statusMenu.appendChild(b);
  }
  statusMenu.querySelectorAll(".check").forEach((c) => c.style.display = "none");
  var grid = document.createElement("div");
  grid.className = "score-grid";
  for (let n = 1; n <= 10; n++) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "score-cell";
    c.dataset.score = String(n);
    c.textContent = String(n);
    c.addEventListener("click", () => {
      closeMenus();
      void saveMal({ score: n });
    });
    grid.appendChild(c);
  }
  var clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "score-clear";
  clearBtn.textContent = "Clear rating";
  clearBtn.addEventListener("click", () => {
    closeMenus();
    void saveMal({ score: 0 });
  });
  scoreMenu.append(grid, clearBtn);
  function closeMenus() {
    statusMenu.hidden = true;
    scoreMenu.hidden = true;
  }
  function toggleMenu(menu) {
    const willOpen = menu.hidden;
    closeMenus();
    if (willOpen) {
      menu.hidden = false;
      statusMenu.querySelectorAll(".dd-opt").forEach((el) => {
        const chk = el.querySelector(".check");
        if (chk) chk.style.display = el.classList.contains("sel") ? "" : "none";
      });
    }
  }
  statusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(statusMenu);
  });
  scoreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(scoreMenu);
  });
  document.addEventListener("click", closeMenus);
  malNudge.addEventListener("click", openSettings);
  async function getTabStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/crunchyroll\.com/.test(tab.url ?? "")) {
        currentMeta = null;
        return;
      }
      const st = await chrome.tabs.sendMessage(tab.id, {
        type: "GET_STATUS"
      });
      currentMeta = st?.meta ?? null;
    } catch {
      currentMeta = null;
    }
  }
  async function refresh() {
    if (!settings) settings = await getSettings().catch(() => settings);
    await getTabStatus();
    if (currentMeta) {
      idleView.hidden = true;
      watchingView.hidden = false;
      const key = metaKey(currentMeta);
      if (key !== lastMetaKey) {
        lastMetaKey = key;
        malResp = void 0;
        void loadMal();
      }
      renderHero();
    } else {
      watchingView.hidden = true;
      idleView.hidden = false;
      lastMetaKey = "";
      void renderRun();
      void renderResume();
      void renderIdleHistory();
      loadHomeContent();
    }
  }
  async function renderIdleHistory() {
    const items = await getHistory();
    idleHistory.replaceChildren();
    idleHistorySection.hidden = items.length === 0;
    for (const it of items.slice(0, 12)) {
      const el = document.createElement("div");
      el.className = "cw";
      el.innerHTML = `<div class="ph"></div><div class="t"></div><div class="s"></div>`;
      setBg(el.querySelector(".ph"), it.thumbnail);
      el.querySelector(".t").textContent = it.series;
      el.querySelector(".s").textContent = [
        it.season ? `S${it.season}` : null,
        it.episode ? `E${it.episode}` : null
      ].filter(Boolean).join(" ");
      el.title = it.series;
      el.addEventListener("click", () => void openEpisode(it.url));
      idleHistory.appendChild(el);
    }
  }
  $("#idle-clear").addEventListener("click", async () => {
    await clearHistory();
    await renderIdleHistory();
  });
  async function openEpisode(url) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.update(tab.id, { url });
  }
  async function openCrSearch(title) {
    await openEpisode(`https://www.crunchyroll.com/search?q=${encodeURIComponent(title)}`);
  }
  function posterCard(picture, title, sub, opts = {}) {
    const card = document.createElement("div");
    card.className = "pcard";
    card.title = title;
    const ph = document.createElement("div");
    ph.className = "ph";
    setBg(ph, picture);
    if (opts.score) {
      const b = document.createElement("div");
      b.className = "sbadge";
      b.innerHTML = `<span style="color:#ffc24b">\u2605</span>${opts.score.toFixed(opts.score % 1 ? 1 : 0)}`;
      ph.appendChild(b);
    }
    if (opts.progress != null && opts.progress > 0) {
      const bar = document.createElement("div");
      bar.className = "pbar";
      const i = document.createElement("i");
      i.style.width = `${Math.min(100, opts.progress * 100)}%`;
      bar.appendChild(i);
      ph.appendChild(bar);
    }
    const t = document.createElement("div");
    t.className = "pt";
    t.textContent = title;
    const s = document.createElement("div");
    s.className = "ps";
    s.textContent = sub;
    card.append(ph, t, s);
    return card;
  }
  var SECONDS_PER_EP = 24 * 60;
  async function renderRun() {
    const [s, hist] = await Promise.all([getStats(), getHistory()]);
    runTime.textContent = s.secondsSaved > 0 ? formatSaved(s.secondsSaved).replace("~", "") : "0m";
    const eps = Math.round(s.secondsSaved / SECONDS_PER_EP);
    runDesc.innerHTML = "of intros, recaps &amp; credits skipped" + (eps >= 1 ? ` \u2014 that's roughly <b>${eps} full episode${eps === 1 ? "" : "s"}</b> you didn't have to sit through.` : ".");
    const counts = lastNDays(s, 14);
    const max = Math.max(1, ...counts);
    runBars.replaceChildren();
    counts.forEach((count, i) => {
      const bar = document.createElement("div");
      bar.className = "bar" + (count > 0 ? " on" : "");
      bar.style.height = count > 0 ? `${Math.max(10, Math.round(count / max * 38))}px` : "5px";
      const ago = counts.length - 1 - i;
      bar.title = `${count} skip${count === 1 ? "" : "s"} \xB7 ${ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago}d ago`}`;
      runBars.appendChild(bar);
    });
    runTotal.textContent = `${s.skips} skips total`;
    runSegments.textContent = String(s.skips);
    runShows.textContent = String(hist.length);
  }
  async function renderResume() {
    const [latest] = await getHistory();
    if (!latest) {
      resumeCard.hidden = true;
      return;
    }
    resumeCard.hidden = false;
    setBg(resumeThumb, latest.thumbnail);
    resumeTitle.textContent = latest.series;
    const se = [latest.season ? `S${latest.season}` : null, latest.episode ? `E${latest.episode}` : null].filter(Boolean).join(" \xB7 ");
    resumeSub.textContent = [se, latest.episodeTitle].filter(Boolean).join(" \u2014 ");
    resumeCard.onclick = () => void openEpisode(latest.url);
  }
  var homeLoaded = false;
  function loadHomeContent() {
    if (homeLoaded) return;
    homeLoaded = true;
    void loadMyList();
    void loadSeasonal();
  }
  async function loadMyList() {
    myListSection.hidden = true;
    try {
      const r = await requestMyList("watching");
      if (!r.connected || !r.items.length) return;
      myListRail.replaceChildren();
      for (const it of r.items) {
        const card = posterCard(
          it.picture,
          it.title,
          it.total ? `${it.watched} / ${it.total}` : `Ep ${it.watched}`,
          { progress: it.total ? it.watched / it.total : 0 }
        );
        card.addEventListener("click", () => void openCrSearch(it.title));
        myListRail.appendChild(card);
      }
      myListSection.hidden = false;
    } catch {
    }
  }
  async function loadSeasonal() {
    seasonalSection.hidden = true;
    try {
      const r = await requestSeasonal();
      if (!r.items.length) return;
      seasonalRail.replaceChildren();
      for (const it of r.items) {
        const card = posterCard(it.picture, it.title, it.type ?? "TV", { score: it.score });
        card.addEventListener("click", () => void openCrSearch(it.title));
        seasonalRail.appendChild(card);
      }
      seasonalSection.hidden = false;
    } catch {
    }
  }
  async function renderStats() {
    const s = await getStats();
    $("#stats").textContent = s.skips > 0 ? `${s.skips} skips \xB7 ${formatSaved(s.secondsSaved)} saved` : "No skips yet";
  }
  var settingsView = $("#settingsView");
  var setAutoNext = $("#set-autoNext");
  var setKeepWatching = $("#set-keepWatching");
  var setShowToast = $("#set-showToast");
  var setSkip = Object.fromEntries(
    SKIP_SEGMENTS.map((k) => [k, $(`#set-skip-${k}`)])
  );
  var setMalStatusEl = $("#set-mal-status");
  var setConnectBtn = $("#set-connect");
  var setDisconnectBtn = $("#set-disconnect");
  var setMalEnabled = $("#set-malEnabled");
  var setMappingsWrap = $("#set-mappings-wrap");
  var setMappingsEl = $("#set-mappings");
  var modeRadios = Array.from(document.querySelectorAll('input[name="set-mode"]'));
  async function renderMalSettings() {
    setMalEnabled.checked = !!(await getSettings()).mal.enabled;
    const token = await getTokenData();
    if (token) {
      setConnectBtn.hidden = true;
      setDisconnectBtn.hidden = false;
      setMalStatusEl.textContent = "Connected";
      getUserName(token.access).then((name) => setMalStatusEl.textContent = `Connected as ${name}`).catch(() => {
      });
    } else {
      setConnectBtn.hidden = false;
      setDisconnectBtn.hidden = true;
      setMalStatusEl.textContent = "Not connected";
    }
    const entries = Object.entries(await getMappings());
    setMappingsWrap.hidden = entries.length === 0;
    setMappingsEl.replaceChildren();
    for (const [key, m] of entries) {
      const row = document.createElement("div");
      row.className = "set-map-row";
      const title = document.createElement("span");
      title.className = "set-map-title";
      title.textContent = m.title;
      title.title = m.title;
      const id = document.createElement("input");
      id.type = "text";
      id.className = "set-map-id";
      id.value = String(m.mediaId);
      id.addEventListener("change", async () => {
        const n = Number(id.value);
        if (Number.isInteger(n) && n > 0) await setMapping(key, { ...m, mediaId: n, pinned: true });
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "set-map-del";
      del.setAttribute("aria-label", `Remove ${m.title}`);
      del.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      del.addEventListener("click", async () => {
        await removeMapping(key);
        await renderMalSettings();
      });
      row.append(title, id, del);
      setMappingsEl.appendChild(row);
    }
  }
  async function renderSettings() {
    const s = await getSettings();
    setAutoNext.checked = s.autoNext;
    setKeepWatching.checked = s.keepWatching;
    setShowToast.checked = s.showToast;
    for (const k of SKIP_SEGMENTS) setSkip[k].checked = s.skip[k];
    for (const r of modeRadios) r.checked = r.value === s.mode;
    await renderMalSettings();
  }
  function openSettings() {
    settingsView.hidden = false;
    void renderSettings();
  }
  setAutoNext.addEventListener("change", () => patchSettings({ autoNext: setAutoNext.checked }));
  setKeepWatching.addEventListener("change", () => patchSettings({ keepWatching: setKeepWatching.checked }));
  setShowToast.addEventListener("change", () => patchSettings({ showToast: setShowToast.checked }));
  for (const k of SKIP_SEGMENTS) {
    setSkip[k].addEventListener("change", async () => {
      const s = await getSettings();
      await patchSettings({ skip: { ...s.skip, [k]: setSkip[k].checked } });
    });
  }
  for (const r of modeRadios) {
    r.addEventListener("change", () => {
      if (r.checked) void patchSettings({ mode: r.value });
    });
  }
  setMalEnabled.addEventListener("change", async () => {
    const s = await getSettings();
    await patchSettings({ mal: { ...s.mal, enabled: setMalEnabled.checked } });
  });
  setConnectBtn.addEventListener("click", async () => {
    setConnectBtn.disabled = true;
    setMalStatusEl.textContent = "Connecting\u2026";
    try {
      const r = await startMalAuth();
      if (!r.ok) setMalStatusEl.textContent = `Connect failed: ${r.error ?? "error"}`;
    } catch {
    } finally {
      setConnectBtn.disabled = false;
      await renderMalSettings();
    }
  });
  setDisconnectBtn.addEventListener("click", async () => {
    await clearToken();
    await renderMalSettings();
  });
  $("#open-settings2").addEventListener("click", openSettings);
  $("#set-back").addEventListener("click", () => {
    settingsView.hidden = true;
    lastMetaKey = "";
    void refresh();
  });
  var recentView = $("#recentView");
  var recList = $("#rec-list");
  function relTime(ts) {
    const m = Math.floor((Date.now() - ts) / 6e4);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
  }
  async function renderRecent() {
    const items = await getHistory();
    recList.replaceChildren();
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "rec-empty";
      e.textContent = "Nothing yet \u2014 episodes you open show up here.";
      recList.appendChild(e);
      return;
    }
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "rec-item";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "rec-open";
      open.innerHTML = `<div class="rec-thumb"></div><div class="rec-main"><div class="rec-series"></div><div class="rec-sub"></div></div><span class="rec-time"></span>`;
      setBg(open.querySelector(".rec-thumb"), it.thumbnail);
      open.querySelector(".rec-series").textContent = it.series;
      const se = [it.season ? `S${it.season}` : null, it.episode ? `E${it.episode}` : null].filter(Boolean).join(" ");
      open.querySelector(".rec-sub").innerHTML = `<span class="se"></span>${it.episodeTitle ? " \xB7 " + it.episodeTitle : ""}`;
      open.querySelector(".se").textContent = se;
      open.querySelector(".rec-time").textContent = relTime(it.updatedAt);
      open.addEventListener("click", () => void openEpisode(it.url));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "rec-del";
      del.setAttribute("aria-label", `Remove ${it.series}`);
      del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      del.addEventListener("click", async () => {
        await removeHistory(it.series);
        await renderRecent();
      });
      row.append(open, del);
      recList.appendChild(row);
    }
  }
  $("#open-recent").addEventListener("click", () => {
    recentView.hidden = false;
    void renderRecent();
  });
  $("#rec-back").addEventListener("click", () => recentView.hidden = true);
  $("#rec-clear").addEventListener("click", async () => {
    await clearHistory();
    await renderRecent();
  });
  onSettingsChanged((s) => {
    settings = s;
  });
  var refreshTimer;
  function scheduleRefresh() {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void refresh(), 250);
  }
  chrome.tabs.onActivated.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.url || info.status === "complete") scheduleRefresh();
  });
  window.setInterval(() => void refresh(), 3e3);
  void (async () => {
    settings = await getSettings().catch(() => settings);
    await renderStats();
    await refresh();
  })();
})();
