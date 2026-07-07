/**
 * Side panel shell: decides which view is showing (watching vs. home dashboard),
 * polls the active tab for the current episode, and wires the view modules
 * together. All view rendering lives in watching.ts / home.ts / settings-view.ts
 * / recent.ts.
 */
import type { ContentStatusRequest, TabStatusResponse } from '@/shared/messages';
import type { TrackerMeta } from '@/shared/types';
import { formatSaved, getStats } from '@/shared/stats';
import { $, scrollPanelTop } from './helpers';
import { refreshMalStatus, updateWatching } from './watching';
import {
  invalidateHome,
  loadHomeContent,
  renderIdleAll,
  renderIdleHistory,
  renderResume,
  renderRun,
} from './home';
import { initSettingsView } from './settings-view';
import './recent';
import './bookmarks';
import './sleep-dock';

const watchingView = $('#watchingView');
const idleView = $('#idleView');

let currentMeta: TrackerMeta | null = null;
let idleRendered = false; // idle dashboard built? (guards poll-tick rebuilds)
let inIdle = false; // last rendered view (drives the return-to-show refresh)

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
    const cameFromIdle = inIdle;
    inIdle = false;
    updateWatching(currentMeta);
    // Returning to the SAME show after time away: the watching cache is kept
    // (wiping it re-enters the skeleton loading path and visibly jumps the
    // layout), so refresh the MAL numbers silently in place instead. A
    // different show takes updateWatching's full loading path anyway.
    if (cameFromIdle) {
      refreshMalStatus();
      scrollPanelTop(); // arriving on the show page starts at the top
    }
  } else {
    watchingView.hidden = true;
    idleView.hidden = false;
    if (!inIdle) scrollPanelTop(); // arriving on the home view starts at the top
    inIdle = true;
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
  // MAL connection may have changed — re-fetch the show SILENTLY (repaint in
  // place). A cache reset here would re-enter the new-show loading path:
  // skeleton lines pop in above the meta strip and the air pill re-mounts,
  // visibly jumping the content the moment you leave settings.
  refreshMalStatus();
  invalidateHome(); // re-pull My List / Seasonal / Recs
  idleRendered = false; // re-render idle sections on return
  scrollPanelTop(); // leaving settings lands at the top of the page
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

// PUSH path — the reason the idle→watching flip is fast. Tab events fire when
// the page NAVIGATES, but the episode metadata is scraped a beat later; a
// GET_STATUS poll at navigation time comes back empty and the panel would sit
// on the home view until the next tick. The content script broadcasts
// EPISODE_META the moment the scrape resolves, so reacting to it flips the
// view immediately (no debounce — this message is the settled state).
chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'EPISODE_META') void refresh();
  // Progress-sync wrote to MAL — repaint the Your-list card with fresh counts
  // (silent refetch: same show, no skeleton flash).
  if (msg?.type === 'MAL_UPDATED') refreshMalStatus();
  return false; // the service worker owns the response, not the panel
});

// Safety-net poll only: tab listeners + the EPISODE_META push above catch real
// transitions, so this just heals missed events.
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
});

// ── boot ────────────────────────────────────────────────────────────
void (async () => {
  await renderStats();
  await refresh();
})();
