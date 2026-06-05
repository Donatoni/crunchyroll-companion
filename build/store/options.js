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
  async function patchSettings(patch) {
    const next = withDefaults({ ...await getSettings(), ...patch });
    await saveSettings(next);
    return next;
  }

  // src/shared/tracker-store.ts
  var TOKEN_KEY = "mal_token";
  var MAP_KEY = "mal_mappings";
  async function getTokenData() {
    const r = await chrome.storage.local.get(TOKEN_KEY);
    return r[TOKEN_KEY] ?? null;
  }
  async function setTokenData(token) {
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
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

  // src/shared/mal-config.ts
  var MAL_CLIENT_ID = "9bb4b1bb5cdb9697b154bc9739f9e607";

  // src/shared/mal.ts
  var AUTHORIZE = "https://myanimelist.net/v1/oauth2/authorize";
  var TOKEN = "https://myanimelist.net/v1/oauth2/token";
  var API = "https://api.myanimelist.net/v2";
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
  async function getUserName(access) {
    const res = await fetch(`${API}/users/@me?fields=name`, {
      headers: { Authorization: `Bearer ${access}` }
    });
    if (!res.ok) throw new Error(`MAL HTTP ${res.status}`);
    return (await res.json()).name;
  }

  // src/options/options.ts
  var $ = (id) => document.querySelector(`#${id}`);
  var enabledEl = $("enabled");
  var runDot = $("runDot");
  var runText = $("runText");
  var masterBox = $("masterBox");
  var masterSub = $("masterSub");
  var statusEl = $("status");
  var skipEls = Array.from(
    document.querySelectorAll("input[data-skip]")
  );
  var modeEls = Array.from(
    document.querySelectorAll('input[name="mode"]')
  );
  var boolKeys = ["autoNext", "keepWatching", "showToast"];
  var boolEls = Object.fromEntries(
    boolKeys.map((k) => [k, $(k)])
  );
  var statusTimer;
  function flashSaved() {
    statusEl.classList.add("show");
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => statusEl.classList.remove("show"), 1100);
  }
  function applyEnabled(enabled) {
    document.body.classList.toggle("disabled", !enabled);
    runDot.classList.toggle("idle", !enabled);
    runText.textContent = enabled ? "Running on Crunchyroll" : "Paused";
    masterBox.classList.toggle("on", enabled);
    masterSub.textContent = enabled ? "Enabled" : "Disabled";
  }
  var navItems = Array.from(document.querySelectorAll(".nav-item"));
  var panels = Array.from(document.querySelectorAll(".panel"));
  for (const item of navItems) {
    item.addEventListener("click", () => {
      const tab = item.dataset.tab;
      for (const n of navItems) n.classList.toggle("active", n === item);
      for (const p of panels) p.classList.toggle("active", p.dataset.panel === tab);
    });
  }
  async function render() {
    const s = await getSettings();
    enabledEl.checked = s.enabled;
    for (const k of boolKeys) boolEls[k].checked = s[k];
    for (const el of skipEls) el.checked = s.skip[el.dataset.skip];
    for (const el of modeEls) el.checked = el.value === s.mode;
    applyEnabled(s.enabled);
  }
  enabledEl.addEventListener("change", async () => {
    await patchSettings({ enabled: enabledEl.checked });
    applyEnabled(enabledEl.checked);
    flashSaved();
  });
  for (const k of boolKeys) {
    boolEls[k].addEventListener("change", async () => {
      await patchSettings({ [k]: boolEls[k].checked });
      flashSaved();
    });
  }
  for (const el of skipEls) {
    el.addEventListener("change", async () => {
      const current = (await getSettings()).skip;
      await patchSettings({
        skip: { ...current, [el.dataset.skip]: el.checked }
      });
      flashSaved();
    });
  }
  for (const el of modeEls) {
    el.addEventListener("change", async () => {
      if (el.checked) {
        await patchSettings({ mode: el.value });
        flashSaved();
      }
    });
  }
  var malEnabledEl = $("malEnabled");
  var malConnect = $("mal-connect");
  var connectBtn = $("connect");
  var disconnectBtn = $("disconnect");
  var malStatusEl = $("mal-status");
  var mappingsWrap = $("mappings-wrap");
  var mappingsEl = $("mappings");
  async function renderMappings() {
    const mappings = await getMappings();
    const entries = Object.entries(mappings);
    mappingsWrap.hidden = entries.length === 0;
    mappingsEl.replaceChildren();
    for (const [key, m] of entries) {
      const row = document.createElement("div");
      row.className = "map-row";
      const title = document.createElement("span");
      title.className = "map-title";
      title.textContent = m.title;
      const id = document.createElement("input");
      id.type = "text";
      id.value = String(m.mediaId);
      id.title = "MyAnimeList anime ID";
      id.addEventListener("change", async () => {
        const n = Number(id.value);
        if (Number.isInteger(n) && n > 0) {
          await setMapping(key, { ...m, mediaId: n, pinned: true });
          flashSaved();
        }
      });
      const del = document.createElement("button");
      del.textContent = "\u2715";
      del.title = "Remove mapping";
      del.addEventListener("click", async () => {
        await removeMapping(key);
        await renderMappings();
      });
      row.append(title, id, del);
      mappingsEl.appendChild(row);
    }
  }
  async function renderMal() {
    const s = await getSettings();
    malEnabledEl.checked = s.mal.enabled;
    const token = await getTokenData();
    malConnect.classList.toggle("connected", !!token);
    if (token) {
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
      malStatusEl.textContent = "Connected";
      getUserName(token.access).then((name) => malStatusEl.textContent = `Connected as ${name}`).catch(() => malStatusEl.textContent = "Connected (token may need refresh)");
    } else {
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
      malStatusEl.textContent = "Not connected";
    }
    await renderMappings();
  }
  malEnabledEl.addEventListener("change", async () => {
    const s = await getSettings();
    await patchSettings({ mal: { ...s.mal, enabled: malEnabledEl.checked } });
    flashSaved();
  });
  connectBtn.addEventListener("click", async () => {
    malStatusEl.textContent = "Opening MyAnimeList\u2026";
    try {
      const redirectUri = chrome.identity.getRedirectURL();
      const verifier = randomVerifier();
      const state = randomVerifier().slice(0, 16);
      const responseUrl = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
          { url: authorizeUrl(verifier, redirectUri, state), interactive: true },
          (url) => {
            const e = chrome.runtime.lastError;
            if (e) reject(new Error(e.message));
            else resolve(url);
          }
        );
      });
      const params = new URLSearchParams((responseUrl ?? "").split("?")[1] ?? "");
      if (params.get("state") !== state) throw new Error("State mismatch");
      const code = params.get("code");
      if (!code) throw new Error(params.get("error") ?? "No authorization code");
      const token = await exchangeCode(code, verifier, redirectUri);
      await setTokenData(token);
      await renderMal();
    } catch (err) {
      malStatusEl.textContent = `Connect failed: ${err instanceof Error ? err.message : "error"}`;
    }
  });
  disconnectBtn.addEventListener("click", async () => {
    await clearToken();
    await renderMal();
  });
  void render();
  void renderMal();
})();
