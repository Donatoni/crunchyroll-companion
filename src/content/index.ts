import {
  DEFAULT_SETTINGS,
  getSettings,
  onSettingsChanged,
  type Settings,
} from '@/shared/settings';
import {
  broadcastEpisodeToFrames,
  getPostedEpisode,
  initFrameEpisodeSync,
  onEpisodeChange,
  parseEpisode,
  setBroadcastEpisode,
} from './navigation';
import { waitForVideo } from './player';
import { getSkipSegments } from './skip-api';
import { attachSkipEngine } from './skip-engine';
import { startDomSkip } from './dom-skip';
import { attachAutoNext } from './autonext';
import { attachAutoPip } from './auto-pip';
import { attachPipButton } from './pip-button';
import { keepPipEnabled } from './pip-enable';
import { attachProgress } from './progress';
import { extractMeta } from './meta';
import { startKeepWatching } from './keep-watching';
import { recordHistory } from '@/shared/history';
import { showToast } from './toast';
import { requestSkipEvents, sendEpisodeMeta } from '@/shared/messages';
import { isExtensionContextValid } from '@/shared/runtime';
import { log } from '@/shared/log';
import type { EpisodeContext } from '@/shared/types';

log('content script loaded in', location.href);

// Cross-frame episode handshake: lets the player iframe learn the current
// episode id from the top frame instead of trusting its stale referrer.
initFrameEpisodeSync();

/**
 * True when this frame is currently showing a watch page (URL has /watch/).
 * Evaluated live, NOT once at load: Crunchyroll is an SPA, so the same top-frame
 * document goes series-page -> watch-page without reloading the content script.
 * A cached value would stay false after navigating in from a series page.
 */
const isTopWatch = () => /\/watch\//.test(location.href);

chrome.runtime.onMessage.addListener(
  (
    msg: { type?: string; text?: string },
    _sender,
    sendResponse: (r: unknown) => void,
  ) => {
    // Worker -> top frame: show a tracker result toast (top frame only, so it
    // isn't duplicated inside the iframe).
    if (msg?.type === 'TRACKER_TOAST' && isTopWatch() && msg.text) {
      showToast({ message: msg.text, durationMs: 4000 });
      return false;
    }
    // Popup -> page: live status for the card. Only the top watch frame answers.
    if (msg?.type === 'GET_STATUS') {
      if (!isTopWatch()) return false;
      const ctx = parseEpisode();
      if (!ctx) {
        sendResponse({ meta: null, segments: 0 });
        return true;
      }
      const meta = extractMeta(ctx.episodeId);
      requestSkipEvents(ctx.episodeId)
        .then((r) => sendResponse({ meta, segments: r.ok ? r.segments.length : 0 }))
        .catch(() => sendResponse({ meta, segments: 0 }));
      return true; // async response
    }
    return false;
  },
);

/**
 * Content-script entry. Coordinates, per episode:
 *   - seek-mode auto-skip from skip-events data (when available), and
 *   - a DOM fallback that clicks the native skip button otherwise,
 *   - auto-play-next.
 *
 * Runs in every frame (all_frames). In the watch document it gets the episode id
 * from the URL and can use the API; in an embedded player iframe (no episode id)
 * it still drives the DOM fallback once a <video> appears.
 */

// Live settings mirror, kept fresh so popup/options toggles apply instantly.
// Starts from defaults, then loads the real values asynchronously.
let settings: Settings = DEFAULT_SETTINGS;
getSettings()
  .then((s) => (settings = s))
  .catch(() => {});
onSettingsChanged((s) => (settings = s));

// Runs for the whole frame lifetime (not per-episode): dismiss "still watching"
// / profile prompts so auto-play sessions aren't interrupted.
startKeepWatching(() => settings.enabled && settings.keepWatching);

// Episode number for the show currently playing, reset per session. In the top
// frame it comes from the metadata scrape; in the player iframe (which owns the
// <video> and actually runs the skip engine) it arrives via the cross-frame
// broadcast — without that, the gate would never see a number there and
// "skip only after episode 1" would silently not work.
let currentEpisode: number | null = null;

/**
 * "Skip only after episode 1" gate. While the setting is on and the episode
 * number is still unknown, we HOLD skipping rather than allow it: episode-1
 * intros often start at 0:00, and skipping before the number resolves would
 * defeat the feature. The number lands within a couple of seconds (JSON-LD /
 * og:title, then the cross-frame broadcast), after which mid-intro skips still
 * fire — the segment window is checked continuously, not just at its start.
 */
const skipAllowed = () => {
  if (!settings.skipAfterFirstOnly) return true;
  const ep = currentEpisode ?? getPostedEpisode();
  return ep != null && ep !== 1;
};

let teardown: Array<() => void> = [];
function teardownSession(): void {
  for (const fn of teardown) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  teardown = [];
}

/** Poll for the episode's metadata, then push it to the worker + record history. */
function captureEpisode(ctx: EpisodeContext): void {
  let tries = 0;
  let lastKey = '';
  const attempt = () => {
    // Bail if we've navigated to a different episode in the meantime.
    if (parseEpisode()?.episodeId !== ctx.episodeId) return;
    const meta = extractMeta(ctx.episodeId);
    if (meta) {
      // Feed the "skip only after episode 1" gate as soon as the number is
      // known — locally and in the player iframe (via the broadcast below).
      currentEpisode = meta.episode;
      // On SPA auto-advance the series name is already present while the
      // on-screen episode number still shows the PREVIOUS episode for a beat.
      // Re-send whenever the scraped episode identity changes so the worker
      // ends up with the NEW episode's number. Crucially we keep polling the
      // full window instead of stopping at the first (possibly stale) value —
      // the tracker only moves forward, so a lingering stale number would
      // silently skip the increment.
      const key = `${meta.series}|${meta.season}|${meta.episode}|${meta.episodeTitle}`;
      if (key !== lastKey) {
        lastKey = key;
        log('episode meta', `${meta.series} S${meta.season} E${meta.episode}`);
        // Push the resolved number to the player iframe (skip-after-ep1 gate).
        setBroadcastEpisode(ctx.episodeId, meta.episode);
        sendEpisodeMeta(meta);
        void recordHistory({
          episodeId: meta.episodeId,
          url: ctx.url,
          series: meta.series,
          episodeTitle: meta.episodeTitle,
          episode: meta.episode,
          season: meta.season,
          thumbnail: meta.thumbnail,
        });
      }
    }
    // ~12s window: long enough for the SPA to settle the new episode's DOM,
    // far shorter than the time until the "watched" threshold fires.
    if (++tries < 20) window.setTimeout(attempt, 600);
  };
  attempt();
}

function startSession(ctx: EpisodeContext | null): void {
  teardownSession();
  // New episode: forget the previous episode's number until the fresh scrape lands.
  currentEpisode = null;

  // Top frame: scrape episode metadata for the tracker + history. The page's
  // JSON-LD lands a beat after navigation, so poll until it's present.
  if (isTopWatch() && ctx) {
    captureEpisode(ctx);
    // Tell the player iframe which episode is now active so its seek engine
    // doesn't keep using the previous episode's skip data after an auto-advance.
    broadcastEpisodeToFrames();
  }

  const cancelWait = waitForVideo(async (video) => {
    // When we have an episode id, try the skip-events API for precise seeking.
    const segments = ctx ? await getSkipSegments(ctx.episodeId) : [];
    log(
      'video ready.',
      ctx ? `episode=${ctx.episodeId}` : 'no episode id (iframe)',
      `skip segments=${segments.length}`,
      segments.length ? `[${segments.map((s) => s.type).join(', ')}]` : '',
      `mode=${settings.mode} enabled=${settings.enabled}`,
      `skip=${Object.entries(settings.skip)
        .filter(([, on]) => on)
        .map(([k]) => k)
        .join('/')}`,
    );
    // API is "active" only when seek mode is on AND we actually have data.
    // dom-skip defers while the seek engine owns skipping; otherwise it clicks.
    const apiActive = () => settings.mode === 'seek' && segments.length > 0;

    if (segments.length > 0) {
      teardown.push(attachSkipEngine(video, segments, () => settings, skipAllowed).detach);
    }

    teardown.push(
      startDomSkip(
        () =>
          settings.enabled &&
          skipAllowed() &&
          (settings.mode === 'click' || !apiActive()),
      ).stop,
    );

    teardown.push(
      attachAutoNext(video, () => settings.enabled && settings.autoNext).detach,
    );

    // Crunchyroll blocks PiP via disablePictureInPicture; clear it (and keep it
    // clear) so both the button and Auto-PiP have a PiP-capable element.
    teardown.push(keepPipEnabled(video).detach);

    teardown.push(
      attachAutoPip(video, () => settings.enabled && settings.autoPip).detach,
    );

    // Manual PiP button on the player — always available (a click is a real
    // gesture, so it works even when browser-initiated Auto-PiP can't fire).
    teardown.push(attachPipButton(video).detach);

    if (ctx) {
      teardown.push(
        attachProgress(
          video,
          ctx.episodeId,
          () => settings.enabled && settings.mal.enabled,
        ).detach,
      );
    }
  });

  teardown.push(cancelWait);
}

const unsubscribeNav = onEpisodeChange(startSession);

// Orphan watchdog: when the extension is reloaded/updated, this content script
// keeps running but its chrome.* APIs throw "Extension context invalidated".
// Detect that and shut our recurring work down so the page goes quiet instead
// of spamming errors. (Reload the Crunchyroll tab to get a fresh content script.)
const orphanWatch = window.setInterval(() => {
  if (isExtensionContextValid()) return;
  window.clearInterval(orphanWatch);
  teardownSession();
  unsubscribeNav();
  log('extension context invalidated — content script stopped (reload the tab)');
}, 1000);
