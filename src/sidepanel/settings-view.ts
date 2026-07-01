/**
 * Settings slide-over: skip method/segments, playback toggles, cloud sync
 * sign-in, MyAnimeList connection, and the Show → MAL matches editor.
 */
import { getSettings, patchSettings, type SkipMode } from '@/shared/settings';
import type { SkipType } from '@/shared/types';
import { requestSyncNow } from '@/shared/messages';
import { getSession, signInWithGoogle, signOut } from '@/shared/supabase';
import { getSyncMeta } from '@/shared/sync';
import { getUserName } from '@/shared/mal';
import { connectMal } from '@/shared/mal-auth';
import {
  clearToken,
  getMappings,
  getTokenData,
  removeMapping,
  setMapping,
} from '@/shared/tracker-store';
import { $ } from './helpers';

const SKIP_SEGMENTS: SkipType[] = ['intro', 'recap', 'credits', 'preview'];

const settingsView = $('#settingsView');
const setAutoNext = $<HTMLInputElement>('#set-autoNext');
const setAutoPip = $<HTMLInputElement>('#set-autoPip');
const setKeepWatching = $<HTMLInputElement>('#set-keepWatching');
const setShowToast = $<HTMLInputElement>('#set-showToast');
const setSkipFirst = $<HTMLInputElement>('#set-skipFirst');
const setSkip = Object.fromEntries(
  SKIP_SEGMENTS.map((k) => [k, $<HTMLInputElement>(`#set-skip-${k}`)]),
) as Record<SkipType, HTMLInputElement>;
const setMalStatusEl = $('#set-mal-status');
const setConnectBtn = $<HTMLButtonElement>('#set-connect');
const setDisconnectBtn = $<HTMLButtonElement>('#set-disconnect');
const setMalEnabled = $<HTMLInputElement>('#set-malEnabled');
const setMappingsWrap = $('#set-mappings-wrap');
const setMappingsEl = $('#set-mappings');
const setMappingsToggle = $<HTMLButtonElement>('#set-mappings-toggle');
const setMappingsCount = $('#set-mappings-count');
const modeRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="set-mode"]'));

// Cloud sync
const setSyncStatus = $('#set-sync-status');
const setSyncSignIn = $<HTMLButtonElement>('#set-sync-signin');
const setSyncSignOut = $<HTMLButtonElement>('#set-sync-signout');
const setSyncActions = $('#set-sync-actions');
const setSyncNowBtn = $<HTMLButtonElement>('#set-sync-now');
const setSyncWhen = $('#set-sync-when');

function relSyncTime(ts: number): string {
  if (!ts) return 'never';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function renderSyncSettings(): Promise<void> {
  const session = await getSession();
  if (session) {
    setSyncStatus.textContent = session.email ? `Signed in as ${session.email}` : 'Signed in';
    setSyncSignIn.hidden = true;
    setSyncSignOut.hidden = false;
    setSyncActions.hidden = false;
    const meta = await getSyncMeta();
    setSyncWhen.textContent = meta.lastError
      ? `Error: ${meta.lastError}`
      : relSyncTime(meta.lastSyncedAt);
  } else {
    setSyncStatus.textContent = 'Not signed in';
    setSyncSignIn.hidden = false;
    setSyncSignOut.hidden = true;
    setSyncActions.hidden = true;
  }
}

setSyncSignIn.addEventListener('click', async () => {
  setSyncSignIn.disabled = true;
  setSyncStatus.textContent = 'Signing in…';
  try {
    await signInWithGoogle();
    await renderSyncSettings();
    setSyncWhen.textContent = 'Syncing…';
    await requestSyncNow();
    await renderSyncSettings();
  } catch (err) {
    setSyncStatus.textContent = `Sign-in failed: ${err instanceof Error ? err.message : 'error'}`;
  } finally {
    setSyncSignIn.disabled = false;
  }
});
setSyncSignOut.addEventListener('click', async () => {
  await signOut();
  await renderSyncSettings();
});
setSyncNowBtn.addEventListener('click', async () => {
  setSyncNowBtn.disabled = true;
  setSyncWhen.textContent = 'Syncing…';
  try {
    const r = await requestSyncNow();
    setSyncWhen.textContent = r.ok ? relSyncTime(r.lastSyncedAt) : `Error: ${r.error ?? 'failed'}`;
  } finally {
    setSyncNowBtn.disabled = false;
  }
});

// The Show → MAL matches list is long, so it's collapsed by default.
let mappingsExpanded = false;
function applyMappingsExpanded(): void {
  setMappingsEl.hidden = !mappingsExpanded;
  setMappingsToggle.setAttribute('aria-expanded', String(mappingsExpanded));
}
setMappingsToggle.addEventListener('click', () => {
  mappingsExpanded = !mappingsExpanded;
  applyMappingsExpanded();
});

async function renderMalSettings(): Promise<void> {
  setMalEnabled.checked = !!(await getSettings()).mal.enabled;
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
  setMappingsCount.textContent = entries.length ? String(entries.length) : '';
  applyMappingsExpanded(); // stay collapsed (or keep the user's expanded state) across re-renders
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
    id.addEventListener('change', async () => {
      const n = Number(id.value);
      if (Number.isInteger(n) && n > 0) await setMapping(key, { ...m, mediaId: n, pinned: true });
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'set-map-del';
    del.setAttribute('aria-label', `Remove ${m.title}`);
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
  setAutoNext.checked = s.autoNext;
  setAutoPip.checked = s.autoPip;
  setKeepWatching.checked = s.keepWatching;
  setShowToast.checked = s.showToast;
  setSkipFirst.checked = s.skipAfterFirstOnly;
  for (const k of SKIP_SEGMENTS) setSkip[k].checked = s.skip[k];
  for (const r of modeRadios) r.checked = r.value === s.mode;
  await renderMalSettings();
  await renderSyncSettings();
}

export function openSettings(): void {
  settingsView.hidden = false;
  void renderSettings();
}

setAutoNext.addEventListener('change', () => patchSettings({ autoNext: setAutoNext.checked }));
setAutoPip.addEventListener('change', () => patchSettings({ autoPip: setAutoPip.checked }));
setKeepWatching.addEventListener('change', () => patchSettings({ keepWatching: setKeepWatching.checked }));
setShowToast.addEventListener('change', () => patchSettings({ showToast: setShowToast.checked }));
setSkipFirst.addEventListener('change', () => patchSettings({ skipAfterFirstOnly: setSkipFirst.checked }));
for (const k of SKIP_SEGMENTS) {
  setSkip[k].addEventListener('change', async () => {
    const s = await getSettings();
    await patchSettings({ skip: { ...s.skip, [k]: setSkip[k].checked } });
  });
}
for (const r of modeRadios) {
  r.addEventListener('change', () => { if (r.checked) void patchSettings({ mode: r.value as SkipMode }); });
}
setMalEnabled.addEventListener('change', async () => {
  const s = await getSettings();
  await patchSettings({ mal: { ...s.mal, enabled: setMalEnabled.checked } });
});
setConnectBtn.addEventListener('click', async () => {
  // Run the OAuth flow inline in the side panel. The panel stays open while
  // launchWebAuthFlow's window is up, and invoking it from this page context
  // reliably opens that window — delegating to the service worker (which has no
  // window to host the auth popup) does not.
  setConnectBtn.disabled = true;
  setMalStatusEl.textContent = 'Connecting…';
  try {
    await connectMal();
  } catch (err) {
    setMalStatusEl.textContent = `Connect failed: ${err instanceof Error ? err.message : 'error'}`;
  } finally {
    setConnectBtn.disabled = false;
    await renderMalSettings();
  }
});
setDisconnectBtn.addEventListener('click', async () => {
  await clearToken();
  await renderMalSettings();
});

let onCloseCb: () => void = () => {};

/** Wire the open/close chrome; `onClose` lets the shell refresh stale views. */
export function initSettingsView(onClose: () => void): void {
  onCloseCb = onClose;
}

$('#open-settings2').addEventListener('click', openSettings);
$('#set-back').addEventListener('click', () => {
  settingsView.hidden = true;
  onCloseCb(); // connection/sync state may have changed — let views re-fetch
});
