import {
  getSettings,
  patchSettings,
  type Settings,
  type SkipMode,
} from '@/shared/settings';
import type { SkipType } from '@/shared/types';
import {
  clearToken,
  getMappings,
  getTokenData,
  removeMapping,
  setMapping,
} from '@/shared/tracker-store';
import { getUserName } from '@/shared/mal';
import { startMalAuth } from '@/shared/messages';

const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;

const enabledEl = $<HTMLInputElement>('enabled');
const runDot = $<HTMLSpanElement>('runDot');
const runText = $<HTMLSpanElement>('runText');
const masterBox = $<HTMLDivElement>('masterBox');
const masterSub = $<HTMLDivElement>('masterSub');
const statusEl = $<HTMLDivElement>('status');
const skipEls = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[data-skip]'),
);
const modeEls = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]'),
);

const boolKeys = ['autoNext', 'keepWatching', 'showToast'] as const;
const boolEls = Object.fromEntries(
  boolKeys.map((k) => [k, $<HTMLInputElement>(k)]),
) as Record<(typeof boolKeys)[number], HTMLInputElement>;

let statusTimer: number | undefined;
function flashSaved(): void {
  statusEl.classList.add('show');
  if (statusTimer) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => statusEl.classList.remove('show'), 1100);
}

function applyEnabled(enabled: boolean): void {
  document.body.classList.toggle('disabled', !enabled);
  runDot.classList.toggle('idle', !enabled);
  runText.textContent = enabled ? 'Running on Crunchyroll' : 'Paused';
  masterBox.classList.toggle('on', enabled);
  masterSub.textContent = enabled ? 'Enabled' : 'Disabled';
}

// ── Sidebar tab switching ───────────────────────────────────────────
const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item'));
const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'));
for (const item of navItems) {
  item.addEventListener('click', () => {
    const tab = item.dataset.tab;
    for (const n of navItems) n.classList.toggle('active', n === item);
    for (const p of panels) p.classList.toggle('active', p.dataset.panel === tab);
  });
}

// ── Core settings ───────────────────────────────────────────────────
async function render(): Promise<void> {
  const s = await getSettings();
  enabledEl.checked = s.enabled;
  for (const k of boolKeys) boolEls[k].checked = s[k] as boolean;
  for (const el of skipEls) el.checked = s.skip[el.dataset.skip as SkipType];
  for (const el of modeEls) el.checked = el.value === s.mode;
  applyEnabled(s.enabled);
}

enabledEl.addEventListener('change', async () => {
  await patchSettings({ enabled: enabledEl.checked });
  applyEnabled(enabledEl.checked);
  flashSaved();
});

for (const k of boolKeys) {
  boolEls[k].addEventListener('change', async () => {
    await patchSettings({ [k]: boolEls[k].checked } as Partial<Settings>);
    flashSaved();
  });
}

for (const el of skipEls) {
  el.addEventListener('change', async () => {
    const current = (await getSettings()).skip;
    await patchSettings({
      skip: { ...current, [el.dataset.skip as SkipType]: el.checked },
    });
    flashSaved();
  });
}

for (const el of modeEls) {
  el.addEventListener('change', async () => {
    if (el.checked) {
      await patchSettings({ mode: el.value as SkipMode });
      flashSaved();
    }
  });
}

// ── MyAnimeList sync ────────────────────────────────────────────────
const malEnabledEl = $<HTMLInputElement>('malEnabled');
const malConnect = $<HTMLDivElement>('mal-connect');
const connectBtn = $<HTMLButtonElement>('connect');
const disconnectBtn = $<HTMLButtonElement>('disconnect');
const malStatusEl = $<HTMLSpanElement>('mal-status');
const mappingsWrap = $<HTMLDivElement>('mappings-wrap');
const mappingsEl = $<HTMLDivElement>('mappings');

async function renderMappings(): Promise<void> {
  const mappings = await getMappings();
  const entries = Object.entries(mappings);
  mappingsWrap.hidden = entries.length === 0;
  mappingsEl.replaceChildren();
  for (const [key, m] of entries) {
    const row = document.createElement('div');
    row.className = 'map-row';

    const title = document.createElement('span');
    title.className = 'map-title';
    title.textContent = m.title;

    const id = document.createElement('input');
    id.type = 'text';
    id.value = String(m.mediaId);
    id.title = 'MyAnimeList anime ID';
    id.addEventListener('change', async () => {
      const n = Number(id.value);
      if (Number.isInteger(n) && n > 0) {
        // Pin manual corrections so the auto-resolver never overrides them.
        await setMapping(key, { ...m, mediaId: n, pinned: true });
        flashSaved();
      }
    });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Remove mapping';
    del.addEventListener('click', async () => {
      await removeMapping(key);
      await renderMappings();
    });

    row.append(title, id, del);
    mappingsEl.appendChild(row);
  }
}

async function renderMal(): Promise<void> {
  const s = await getSettings();
  malEnabledEl.checked = s.mal.enabled;

  const token = await getTokenData();
  malConnect.classList.toggle('connected', !!token);
  if (token) {
    connectBtn.hidden = true;
    disconnectBtn.hidden = false;
    malStatusEl.textContent = 'Connected';
    getUserName(token.access)
      .then((name) => (malStatusEl.textContent = `Connected as ${name}`))
      .catch(() => (malStatusEl.textContent = 'Connected (token may need refresh)'));
  } else {
    connectBtn.hidden = false;
    disconnectBtn.hidden = true;
    malStatusEl.textContent = 'Not connected';
  }
  await renderMappings();
}

malEnabledEl.addEventListener('change', async () => {
  const s = await getSettings();
  await patchSettings({ mal: { ...s.mal, enabled: malEnabledEl.checked } });
  flashSaved();
});

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  malStatusEl.textContent = 'Opening MyAnimeList…';
  // The OAuth flow runs in the service worker (single, shared code path) — it
  // owns launchWebAuthFlow + PKCE S256 + token storage. We just reflect the
  // result here.
  try {
    const r = await startMalAuth();
    if (!r.ok) malStatusEl.textContent = `Connect failed: ${r.error ?? 'error'}`;
  } catch {
    /* worker still saves the token even if this context goes away */
  } finally {
    connectBtn.disabled = false;
    await renderMal();
  }
});

disconnectBtn.addEventListener('click', async () => {
  await clearToken();
  await renderMal();
});

void render();
void renderMal();
