/**
 * Side panel shell: decides which view is showing (watching vs. home dashboard),
 * polls the active tab for the current episode, and wires the view modules
 * together. All view rendering lives in watching.ts / home.ts / settings-view.ts
 * / recent.ts.
 */
import type { ContentStatusRequest, TabStatusResponse } from '@/shared/messages';
import type { TrackerMeta } from '@/shared/types';
import { formatSaved, getStats } from '@/shared/stats';
import { $ } from './helpers';
import { resetWatchingCache, updateWatching } from './watching';
import {
  invalidateHome,
  loadHomeContent,
  renderIdleAll,
  renderIdleHistory,
  renderRateReminders,
  renderResume,
  renderRun,
} from './home';
import { initSettingsView } from './settings-view';
import './recent';

const watchingView = $('#watchingView');
const idleView = $('#idleView');

let currentMeta: TrackerMeta | null = null;
let idleRendered = false; // idle dashboard built? (guards poll-tick rebuilds)

// ── status refresh (active tab) ─────────────────────────────────────
async function getTabStatus(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/crunchyroll\.com/.test(tab.url ?? '')) {
      currentMeta = null;
      return;
    }
    const st = await chrome.tabs.sendMessage<ContentStatusRequest, TabStatusResponse>(tab.id, {
      type: 'GET_STATUS',
    });
    currentMeta = st?.meta ?? null;
  } catch {
    currentMeta = null;
  }
}

async function refresh(): Promise<void> {
  await getTabStatus();

  if (currentMeta) {
    idleView.hidden = true;
    watchingView.hidden = false;
    idleRendered = false; // leaving idle — next idle entry re-renders fresh
    updateWatching(currentMeta);
  } else {
    watchingView.hidden = true;
    idleView.hidden = false;
    resetWatchingCache();
    // Render the idle sections only on ENTERING idle, not on every poll tick —
    // rebuilding them resets the "Jump back in" rail's scroll. Live updates
    // come from the storage.onChanged listener below.
    if (!idleRendered) {
      idleRendered = true;
      renderIdleAll();
    }
    loadHomeContent();
  }
}

// ── footer stats ────────────────────────────────────────────────────
async function renderStats(): Promise<void> {
  const s = await getStats();
  $('#stats').textContent =
    s.skips > 0 ? `${s.skips} skips · ${formatSaved(s.secondsSaved)} saved` : 'No skips yet';
}

// ── settings close → stale views re-fetch ───────────────────────────
initSettingsView(() => {
  resetWatchingCache(); // MAL connection may have changed — re-fetch the show
  invalidateHome(); // re-pull My List / Seasonal / Recs
  idleRendered = false; // re-render idle sections on return
  void refresh();
});

// ── live updates ────────────────────────────────────────────────────
let refreshTimer: number | undefined;
function scheduleRefresh(): void {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 250);
}
chrome.tabs.onActivated.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') scheduleRefresh();
});
// Safety-net poll only: tab listeners above catch navigation (incl. SPA URL
// changes, which fire tabs.onUpdated), so this just heals missed events.
window.setInterval(() => void refresh(), 10_000);

// Keep the idle dashboard live without polling: when history/stats change in
// storage AND the idle view is on screen, re-run only the affected renders.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || idleView.hidden) return;
  if (changes.stats) void renderRun();
  if (changes.history) {
    void renderRun(); // "shows" count + the avg-episode line read history too
    void renderResume();
    void renderIdleHistory();
  }
  // A series finished elsewhere (progress-sync) queued a rating reminder.
  if (changes.pendingRatings) void renderRateReminders();
});

// ── boot ────────────────────────────────────────────────────────────
void (async () => {
  await renderStats();
  await refresh();
})();
