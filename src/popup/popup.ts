import { getSettings, patchSettings, type SkipMode } from '@/shared/settings';
import type { SkipType, TrackerMeta } from '@/shared/types';
import { requestMalStatus, setMalStatus, startMalAuth } from '@/shared/messages';
import type {
  ContentStatusRequest,
  MalStatusResponse,
  TabStatusResponse,
} from '@/shared/messages';
import { formatSaved, getStats } from '@/shared/stats';
import { clearHistory, getHistory, removeHistory } from '@/shared/history';
import {
  clearToken,
  getMappings,
  getTokenData,
  removeMapping,
  setMapping,
} from '@/shared/tracker-store';
import { getUserName } from '@/shared/mal';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const MAL_STATUS = [
  { value: 'watching', label: 'Watching', dot: '#3aa0ff' },
  { value: 'completed', label: 'Completed', dot: '#34d27b' },
  { value: 'on_hold', label: 'On hold', dot: '#f0b429' },
  { value: 'dropped', label: 'Dropped', dot: '#f0596b' },
  { value: 'plan_to_watch', label: 'Plan to watch', dot: '#9b9ba3' },
];
const SKIP_SEGMENTS: [SkipType, string][] = [
  ['intro', 'Intro'],
  ['recap', 'Recap'],
  ['credits', 'Outro'],
  ['preview', 'Preview'],
];

type MalPatch = {
  num_watched_episodes?: number;
  status?: string;
  score?: number;
  is_rewatching?: boolean;
};

// ── elements ────────────────────────────────────────────────────────
const enabledEl = $<HTMLInputElement>('#enabled');
const stateEl = $('#state');
const stateDot = $('#stateDot');
const autoNextEl = $<HTMLInputElement>('#autoNext');
const skipSection = $('#skipSection');
const playbackSection = $('#playbackSection');
const armedMeta = $('#armedMeta');
const chipsEl = $('#chips');

const npCard = $('#npCard');
const npThumb = $('#npThumb');
const npTitle = $('#npTitle');
const npSub = $('#npSub');
const npSkip = $('#npSkip');
const npSkipDot = $('#npSkipDot');
const npSkipText = $('#npSkipText');

const malModule = $('#malModule');
const malSynced = $('#malSynced');
const malCard = $('#malCard');
const malNudge = $('#malNudge');
const malNote = $('#malNote');
const malErr = $('#malErr');
const epVal = $('#epVal');
const epTotal = $('#epTotal');
const epMinus = $<HTMLButtonElement>('#epMinus');
const epPlus = $<HTMLButtonElement>('#epPlus');
const statusDd = $('#statusDd');
const statusBtn = $<HTMLButtonElement>('#statusBtn');
const statusMenu = $('#statusMenu');
const statusLabel = $('#statusLabel');
const statusDot = $('#statusDot');
const scoreDd = $('#scoreDd');
const scoreBtn = $<HTMLButtonElement>('#scoreBtn');
const scoreMenu = $('#scoreMenu');
const scoreVal = $('#scoreVal');
const malLink = $<HTMLAnchorElement>('#malLink');
const rewatchBtn = $<HTMLButtonElement>('#rewatchBtn');

let currentMeta: TrackerMeta | null = null;
let currentSegments = 0;
let malTotal: number | null = null;

// ── master / settings ───────────────────────────────────────────────
function armedCount(skip: Record<SkipType, boolean>): number {
  return SKIP_SEGMENTS.filter(([k]) => skip[k]).length;
}

function applyEnabledUI(enabled: boolean, skip: Record<SkipType, boolean>): void {
  stateEl.textContent = enabled ? 'Active' : 'Paused';
  stateDot.classList.toggle('off', !enabled);
  skipSection.classList.toggle('dim', !enabled);
  playbackSection.classList.toggle('dim', !enabled);
  armedMeta.textContent = enabled ? `${armedCount(skip)} ARMED` : 'PAUSED';
}

function chipIcon(active: boolean): string {
  return active
    ? '<span class="chip-ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5 9-10" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
    : '<span class="chip-ic"><span class="ring"></span></span>';
}

function renderChips(skip: Record<SkipType, boolean>): void {
  chipsEl.replaceChildren();
  for (const [k, label] of SKIP_SEGMENTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (skip[k] ? ' active' : '');
    b.innerHTML = chipIcon(skip[k]) + label;
    b.addEventListener('click', async () => {
      const cur = (await getSettings()).skip;
      await patchSettings({ skip: { ...cur, [k]: !cur[k] } });
      void render();
    });
    chipsEl.appendChild(b);
  }
}

async function render(): Promise<void> {
  const s = await getSettings();
  enabledEl.checked = s.enabled;
  autoNextEl.checked = s.autoNext;
  renderChips(s.skip);
  applyEnabledUI(s.enabled, s.skip);
}

enabledEl.addEventListener('change', async () => {
  await patchSettings({ enabled: enabledEl.checked });
  await render();
  void renderStatus();
});
autoNextEl.addEventListener('change', () =>
  patchSettings({ autoNext: autoNextEl.checked }),
);

// ── Now Playing ─────────────────────────────────────────────────────
async function renderStatus(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      currentMeta = null;
    } else {
      const st = await chrome.tabs.sendMessage<ContentStatusRequest, TabStatusResponse>(
        tab.id,
        { type: 'GET_STATUS' },
      );
      currentMeta = st?.meta ?? null;
      currentSegments = st?.segments ?? 0;
    }
  } catch {
    currentMeta = null;
  }
  renderNowPlaying();
  void renderMal();
}

function renderNowPlaying(): void {
  const watching = !!currentMeta && enabledEl.checked;
  npCard.classList.toggle('watching', watching);
  if (watching && currentMeta) {
    npTitle.textContent = currentMeta.series;
    npTitle.title = currentMeta.series;
    const se = [
      currentMeta.season ? `S${currentMeta.season}` : null,
      currentMeta.episode ? `E${currentMeta.episode}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    const seSpan = document.createElement('span');
    seSpan.className = 'se';
    seSpan.textContent = se;
    const rest = document.createTextNode(
      currentMeta.episodeTitle ? ` · ${currentMeta.episodeTitle}` : '',
    );
    npSub.replaceChildren(seSpan, rest);
    npThumb.style.backgroundImage = currentMeta.thumbnail
      ? `url("${currentMeta.thumbnail}")`
      : '';
    npSkip.hidden = false;
    if (currentSegments > 0) {
      npSkipDot.classList.remove('none');
      npSkipText.textContent = `Skip data found · ${currentSegments} segment${
        currentSegments === 1 ? '' : 's'
      }`;
    } else {
      npSkipDot.classList.add('none');
      npSkipText.textContent = 'No skip data for this episode';
    }
  } else {
    npTitle.textContent = 'Not watching';
    npTitle.removeAttribute('title');
    npSub.textContent = 'Open a Crunchyroll episode and your controls appear here.';
    npThumb.style.backgroundImage = '';
    npSkip.hidden = true;
  }
}

// ── MAL card ────────────────────────────────────────────────────────
function setStatusControl(value: string): void {
  const opt = MAL_STATUS.find((o) => o.value === value) ?? MAL_STATUS[0];
  statusLabel.textContent = opt.label;
  statusDot.style.background = opt.dot;
  for (const el of statusMenu.querySelectorAll<HTMLElement>('.dd-opt')) {
    el.classList.toggle('sel', el.dataset.value === opt.value);
  }
}

function setScoreControl(value: number): void {
  scoreVal.textContent = value ? String(value) : '–';
  scoreBtn.classList.toggle('has-score', !!value);
  for (const el of scoreMenu.querySelectorAll<HTMLElement>('.score-cell')) {
    el.classList.toggle('sel', Number(el.dataset.score) === value);
  }
}

function applyMalResponse(r: MalStatusResponse | undefined): void {
  malErr.hidden = true;
  malCard.classList.remove('loading');
  if (!r?.connected) {
    malCard.hidden = true;
    malNote.hidden = true;
    malSynced.hidden = true;
    malNudge.hidden = false;
    return;
  }
  malNudge.hidden = true;
  malSynced.hidden = false;
  if (!r.ok) {
    malCard.hidden = true;
    malNote.hidden = false;
    malNote.textContent = "Couldn't match this show on MyAnimeList yet.";
    return;
  }
  malNote.hidden = true;
  malCard.hidden = false;

  malTotal = r.total ?? null;
  const watched = r.watched ?? 0;
  epVal.textContent = String(watched);
  epTotal.textContent = r.total ? `/${r.total}` : '';
  epMinus.disabled = watched <= 0;
  epPlus.disabled = malTotal != null && watched >= malTotal;
  setStatusControl(r.status ?? 'watching');
  setScoreControl(r.score ?? 0);
  if (r.animeId) malLink.href = `https://myanimelist.net/anime/${r.animeId}`;
  rewatchBtn.hidden = r.status !== 'completed';
}

/**
 * Show the real tracking card right away with placeholder values, so the
 * component (rows, controls) is on screen immediately and only the episode /
 * status / score values fill in once MAL responds. The `loading` class dims and
 * disables the card so stale placeholders can't be clicked mid-load.
 */
function showMalLoading(): void {
  malModule.hidden = false;
  malSynced.hidden = true;
  malNudge.hidden = true;
  malNote.hidden = true;
  malErr.hidden = true;
  malCard.hidden = false;
  malCard.classList.add('loading');
  epVal.textContent = '–';
  epTotal.textContent = '';
  epMinus.disabled = true;
  epPlus.disabled = true;
  setStatusControl('watching');
  setScoreControl(0);
  rewatchBtn.hidden = true;
}

async function renderMal(): Promise<void> {
  const watching = !!currentMeta && enabledEl.checked;
  if (!watching || !currentMeta) {
    malModule.hidden = true;
    return;
  }
  showMalLoading();
  try {
    applyMalResponse(await requestMalStatus(currentMeta));
  } catch {
    applyMalResponse({ ok: false, connected: false });
  }
}

async function saveMal(patch: MalPatch): Promise<void> {
  if (!currentMeta) return;
  malErr.hidden = true;
  malCard.style.opacity = '0.5';
  try {
    const r = await setMalStatus(currentMeta, patch);
    if (r?.ok) {
      applyMalResponse(r);
    } else {
      malErr.textContent = r?.error ? `Couldn't save: ${r.error}` : "Couldn't save to MAL";
      malErr.hidden = false;
      await renderMal();
    }
  } catch {
    malErr.textContent = "Couldn't reach MAL";
    malErr.hidden = false;
  } finally {
    malCard.style.opacity = '1';
  }
}

// stepper
epMinus.addEventListener('click', () => {
  const cur = Number(epVal.textContent) || 0;
  if (cur > 0) void saveMal({ num_watched_episodes: cur - 1 });
});
epPlus.addEventListener('click', () => {
  const cur = Number(epVal.textContent) || 0;
  const n = cur + 1;
  const patch: MalPatch = { num_watched_episodes: n };
  if (malTotal && n >= malTotal) patch.status = 'completed';
  void saveMal(patch);
});

// status dropdown (built once)
for (const o of MAL_STATUS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dd-opt';
  b.dataset.value = o.value;
  b.innerHTML =
    `<span class="dd-dot" style="background:${o.dot}"></span>${o.label}` +
    '<svg class="check" width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5 9-10" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  b.addEventListener('click', () => {
    closeMenus();
    const patch: MalPatch = { status: o.value };
    if (o.value === 'completed' && malTotal) {
      patch.num_watched_episodes = malTotal;
    } else if (o.value === 'watching') {
      // Switching to "Watching" should reflect the episode you're actually on
      // now (e.g. coming back from "Completed"), not the stale count it carried
      // over — mirror the Rewatch button. The episode comes from the CR page.
      const ep = currentMeta?.episode;
      if (ep && ep > 0) {
        patch.num_watched_episodes = ep;
        patch.is_rewatching = false; // a fresh watch, not a tracked rewatch
      }
    }
    void saveMal(patch);
  });
  statusMenu.appendChild(b);
}
// hide the check on unselected via CSS-less approach: toggle visibility in setStatusControl
statusMenu.querySelectorAll<HTMLElement>('.check').forEach((c) => (c.style.display = 'none'));

// score picker (built once)
const grid = document.createElement('div');
grid.className = 'score-grid';
for (let n = 1; n <= 10; n++) {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'score-cell';
  c.dataset.score = String(n);
  c.textContent = String(n);
  c.addEventListener('click', () => {
    closeMenus();
    void saveMal({ score: n });
  });
  grid.appendChild(c);
}
const clearBtn = document.createElement('button');
clearBtn.type = 'button';
clearBtn.className = 'score-clear';
clearBtn.textContent = 'Clear rating';
clearBtn.addEventListener('click', () => {
  closeMenus();
  void saveMal({ score: 0 });
});
scoreMenu.append(grid, clearBtn);

function closeMenus(): void {
  statusDd.classList.remove('open');
  statusMenu.hidden = true;
  scoreDd.classList.remove('open');
  scoreMenu.hidden = true;
}
function toggleMenu(dd: HTMLElement, menu: HTMLElement): void {
  const willOpen = menu.hidden;
  closeMenus();
  if (willOpen) {
    dd.classList.add('open');
    menu.hidden = false;
    // reflect selection check visibility
    statusMenu.querySelectorAll<HTMLElement>('.dd-opt').forEach((el) => {
      const chk = el.querySelector<HTMLElement>('.check');
      if (chk) chk.style.display = el.classList.contains('sel') ? '' : 'none';
    });
  }
}
statusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu(statusDd, statusMenu);
});
scoreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu(scoreDd, scoreMenu);
});
document.addEventListener('click', closeMenus);

rewatchBtn.addEventListener('click', () => {
  rewatchBtn.hidden = true;
  const ep = currentMeta?.episode;
  void saveMal({
    status: 'watching',
    is_rewatching: false,
    num_watched_episodes: ep && ep > 0 ? ep : 1,
  });
});

malNudge.addEventListener('click', () => openSettings());

// ── footer / stats ──────────────────────────────────────────────────
async function renderStats(): Promise<void> {
  const s = await getStats();
  $('#stats').textContent =
    s.skips > 0
      ? `${s.skips} skips · ${formatSaved(s.secondsSaved)} saved`
      : 'No skips yet';
}

// ── settings (in-popup modal) ───────────────────────────────────────
const settingsView = $('#settingsView');
const setKeepWatching = $<HTMLInputElement>('#set-keepWatching');
const setShowToast = $<HTMLInputElement>('#set-showToast');
const setMalStatusEl = $('#set-mal-status');
const setConnectBtn = $<HTMLButtonElement>('#set-connect');
const setDisconnectBtn = $<HTMLButtonElement>('#set-disconnect');
const setMalEnabled = $<HTMLInputElement>('#set-malEnabled');
const setMappingsWrap = $('#set-mappings-wrap');
const setMappingsEl = $('#set-mappings');
const modeRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="set-mode"]'),
);

async function renderMalSettings(): Promise<void> {
  setMalEnabled.checked = (await getSettings()).mal.enabled;
  const token = await getTokenData();
  if (token) {
    setConnectBtn.hidden = true;
    setDisconnectBtn.hidden = false;
    setMalStatusEl.textContent = 'Connected';
    getUserName(token.access)
      .then((name) => (setMalStatusEl.textContent = `Connected as ${name}`))
      .catch(() => {});
  } else {
    setConnectBtn.hidden = false;
    setDisconnectBtn.hidden = true;
    setMalStatusEl.textContent = 'Not connected';
  }

  const entries = Object.entries(await getMappings());
  setMappingsWrap.hidden = entries.length === 0;
  setMappingsEl.replaceChildren();
  for (const [key, m] of entries) {
    const row = document.createElement('div');
    row.className = 'set-map-row';

    const title = document.createElement('span');
    title.className = 'set-map-title';
    title.textContent = m.title;
    title.title = m.title;

    const id = document.createElement('input');
    id.type = 'text';
    id.className = 'set-map-id';
    id.value = String(m.mediaId);
    id.title = 'MyAnimeList anime ID';
    id.addEventListener('change', async () => {
      const n = Number(id.value);
      // Pin manual corrections so the auto-resolver never overrides them.
      if (Number.isInteger(n) && n > 0) await setMapping(key, { ...m, mediaId: n, pinned: true });
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'set-map-del';
    del.title = 'Remove match';
    del.setAttribute('aria-label', `Remove ${m.title} match`);
    del.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.addEventListener('click', async () => {
      await removeMapping(key);
      await renderMalSettings();
    });

    row.append(title, id, del);
    setMappingsEl.appendChild(row);
  }
}

async function renderSettings(): Promise<void> {
  const s = await getSettings();
  setKeepWatching.checked = s.keepWatching;
  setShowToast.checked = s.showToast;
  for (const r of modeRadios) r.checked = r.value === s.mode;
  await renderMalSettings();
}

function openSettings(): void {
  mainView.hidden = true;
  historyView.hidden = true;
  settingsView.hidden = false;
  void renderSettings();
}

setKeepWatching.addEventListener('change', () =>
  patchSettings({ keepWatching: setKeepWatching.checked }),
);
setShowToast.addEventListener('change', () =>
  patchSettings({ showToast: setShowToast.checked }),
);
for (const r of modeRadios) {
  r.addEventListener('change', () => {
    if (r.checked) void patchSettings({ mode: r.value as SkipMode });
  });
}
setMalEnabled.addEventListener('change', async () => {
  const s = await getSettings();
  await patchSettings({ mal: { ...s.mal, enabled: setMalEnabled.checked } });
});
setConnectBtn.addEventListener('click', async () => {
  setConnectBtn.disabled = true;
  setMalStatusEl.textContent = 'Connecting…';
  try {
    const r = await startMalAuth();
    if (!r.ok) setMalStatusEl.textContent = `Connect failed: ${r.error ?? 'error'}`;
  } catch {
    // The popup can close when the auth window steals focus; the worker still
    // finishes and saves the token, so reopening will show "Connected".
  } finally {
    setConnectBtn.disabled = false;
    await renderMalSettings();
  }
});
setDisconnectBtn.addEventListener('click', async () => {
  await clearToken();
  await renderMalSettings();
});

$('#open-options').addEventListener('click', openSettings);
$('#set-back').addEventListener('click', () => {
  settingsView.hidden = true;
  mainView.hidden = false;
  void render();
  void renderStatus();
});

// ── history ─────────────────────────────────────────────────────────
const mainView = $('#mainView');
const historyView = $('#historyView');
const histListEl = $('#hist-list');

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}

async function openEpisode(url: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url });
    window.close();
  }
}

async function renderHistory(): Promise<void> {
  const items = await getHistory();
  histListEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hist-empty';
    empty.innerHTML =
      '<div class="hist-empty-ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 7v5l3 2" stroke="var(--text-3)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="8.5" stroke="var(--text-3)" stroke-width="1.8"/></svg></div>';
    const t = document.createElement('div');
    t.textContent = 'Nothing yet — episodes you open will show up here.';
    empty.appendChild(t);
    histListEl.appendChild(empty);
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    row.title = it.series;

    // Clickable area (opens the episode). Kept separate from the delete button
    // because a <button> can't be nested inside another <button>.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'hist-open';

    const thumb = document.createElement('div');
    thumb.className = 'hist-thumb';
    if (it.thumbnail) thumb.style.backgroundImage = `url("${it.thumbnail}")`;

    const main = document.createElement('div');
    main.className = 'hist-main';
    const series = document.createElement('div');
    series.className = 'hist-series';
    series.textContent = it.series;
    const sub = document.createElement('div');
    sub.className = 'hist-sub';
    const seSpan = document.createElement('span');
    seSpan.className = 'se';
    seSpan.textContent = [it.season ? `S${it.season}` : null, it.episode ? `E${it.episode}` : null]
      .filter(Boolean)
      .join(' ');
    sub.append(seSpan, document.createTextNode(it.episodeTitle ? ` · ${it.episodeTitle}` : ''));
    main.append(series, sub);

    const time = document.createElement('span');
    time.className = 'hist-time';
    time.textContent = relTime(it.updatedAt);

    open.append(thumb, main, time);
    open.addEventListener('click', () => void openEpisode(it.url));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'hist-del';
    del.title = 'Remove from list';
    del.setAttribute('aria-label', `Remove ${it.series} from Recent`);
    del.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.addEventListener('click', async () => {
      await removeHistory(it.series);
      await renderHistory();
    });

    row.append(open, del);
    histListEl.appendChild(row);
  }
}

$('#open-history').addEventListener('click', () => {
  mainView.hidden = true;
  historyView.hidden = false;
  void renderHistory();
});
$('#hist-back').addEventListener('click', () => {
  historyView.hidden = true;
  mainView.hidden = false;
});
$('#hist-clear').addEventListener('click', async () => {
  await clearHistory();
  await renderHistory();
});

// ── boot ────────────────────────────────────────────────────────────
void render();
void renderStats();
void renderStatus();
