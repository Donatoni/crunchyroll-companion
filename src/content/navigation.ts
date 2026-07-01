import type { EpisodeContext } from '@/shared/types';

/**
 * Crunchyroll is a single-page app: moving between episodes updates the URL via
 * the History API without a full reload. We detect those changes by patching
 * pushState/replaceState, listening to popstate, and polling as a safety net.
 */

function matchWatch(url: string): EpisodeContext | null {
  const match = url.match(/\/watch\/([^/?#]+)/);
  return match ? { episodeId: match[1], url } : null;
}

/**
 * Episode id (and number, once the top frame has scraped it) that the parent
 * watch frame told us about (player iframe only). Preferred over
 * `document.referrer` because the referrer is fixed at iframe creation and
 * goes stale when Crunchyroll auto-advances via the SPA and reuses the iframe.
 */
let postedEpisodeId: string | null = null;
let postedEpisode: number | null = null;

/** Episode number the top frame broadcast for the current episode (iframe side). */
export function getPostedEpisode(): number | null {
  return postedEpisode;
}

/** Crunchyroll episode ids are short alphanumeric tokens; reject anything else. */
const EPISODE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** Only accept handshake messages from Crunchyroll frames (incl. static.*). */
function isTrustedOrigin(origin: string): boolean {
  return /^https:\/\/([a-z0-9-]+\.)*crunchyroll\.com$/i.test(origin);
}

/**
 * The top frame's view of the current episode, including the scraped episode
 * number once meta.ts has resolved it. Broadcast to child frames so the player
 * iframe (which owns the <video> and runs the skip engine) can apply
 * episode-number-dependent behaviour like "skip only after episode 1".
 */
let broadcastMeta: { episodeId: string; episode: number | null } | null = null;

/** Top frame: record (and push to child frames) the current episode's number. */
export function setBroadcastEpisode(episodeId: string, episode: number | null): void {
  broadcastMeta = { episodeId, episode };
  broadcastEpisodeToFrames();
}

/**
 * Extract the episode id from a /watch/{episodeId}/slug URL.
 *
 * The actual <video> lives in a cross-origin player iframe whose own URL has no
 * episode id. We resolve it from (in order): this frame's own URL, the episode
 * id broadcast by the parent watch frame, then `document.referrer` as a last
 * resort. If none resolve, we return null and the DOM fallback (clicking the
 * native skip button) takes over.
 */
export function parseEpisode(url: string = location.href): EpisodeContext | null {
  return (
    matchWatch(url) ??
    (postedEpisodeId ? { episodeId: postedEpisodeId, url } : null) ??
    (document.referrer ? matchWatch(document.referrer) : null)
  );
}

/**
 * Cross-frame episode handshake. The top watch frame broadcasts the current
 * episode id to its child frames; a player iframe requests it on load and
 * adopts it (firing a location-change so the session re-attaches with the
 * correct episode's skip data). Targets are '*' since the player iframe is
 * cross-origin; messages are tagged and ignored otherwise.
 */
export function initFrameEpisodeSync(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    // Any frame on the page can postMessage us (ads, embeds); only trust
    // Crunchyroll origins, and validate the id shape so a compromised sibling
    // frame can't inject arbitrary strings into our episode state.
    if (!isTrustedOrigin(e.origin)) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (
      d.source === 'crunchyroll-companion' &&
      typeof d.episodeId === 'string' &&
      EPISODE_ID_RE.test(d.episodeId)
    ) {
      const episode =
        typeof d.episode === 'number' && Number.isFinite(d.episode) ? d.episode : null;
      if (d.episodeId !== postedEpisodeId) {
        postedEpisodeId = d.episodeId;
        postedEpisode = episode;
        window.dispatchEvent(new Event('crunchyroll-companion:locationchange'));
      } else if (episode != null) {
        // Same episode, number arrived later (scrape settled after the initial
        // id-only broadcast) — update in place; gates read this live.
        postedEpisode = episode;
      }
    } else if (d.source === 'crunchyroll-companion-req' && e.source) {
      const id = matchWatch(location.href)?.episodeId;
      if (id) {
        const episode = broadcastMeta?.episodeId === id ? broadcastMeta.episode : null;
        try {
          (e.source as Window).postMessage(
            { source: 'crunchyroll-companion', episodeId: id, episode },
            e.origin,
          );
        } catch {
          /* frame went away */
        }
      }
    }
  });

  // If we're a child frame (the player iframe), ask the parent for the id now.
  if (window.top !== window) {
    try {
      window.parent.postMessage({ source: 'crunchyroll-companion-req' }, '*');
    } catch {
      /* cross-origin parent unreachable — referrer fallback still applies */
    }
  }
}

/**
 * Top watch frame: push the current episode id (+ number, once scraped) down to
 * child player frames. Target '*' because the player iframe is cross-origin and
 * its exact origin varies; the payload is non-sensitive (an episode id already
 * visible in the URL) and receivers validate origin + shape.
 */
export function broadcastEpisodeToFrames(): void {
  const id = matchWatch(location.href)?.episodeId;
  if (!id) return;
  const episode = broadcastMeta?.episodeId === id ? broadcastMeta.episode : null;
  for (let i = 0; i < window.frames.length; i++) {
    try {
      window.frames[i]?.postMessage(
        { source: 'crunchyroll-companion', episodeId: id, episode },
        '*',
      );
    } catch {
      /* cross-origin child — postMessage with '*' still delivers; ignore */
    }
  }
}

type Handler = (ctx: EpisodeContext | null) => void;

let patched = false;
function patchHistory(onChange: () => void): void {
  if (patched) return;
  patched = true;
  const fire = () => window.dispatchEvent(new Event('crunchyroll-companion:locationchange'));
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args);
      fire();
      return result;
    };
  }
  window.addEventListener('crunchyroll-companion:locationchange', onChange);
}

/**
 * Invoke `handler` whenever the active episode changes (including on first load).
 * Returns an unsubscribe function.
 */
export function onEpisodeChange(handler: Handler): () => void {
  // `undefined` sentinel so the very first check always fires, even for frames
  // whose URL has no episode id (e.g. an embedded player iframe).
  let lastId: string | null | undefined = undefined;

  const check = () => {
    const ctx = parseEpisode();
    const id = ctx?.episodeId ?? null;
    if (id !== lastId) {
      lastId = id;
      handler(ctx);
    }
  };

  patchHistory(check);
  window.addEventListener('popstate', check);
  const pollId = window.setInterval(check, 1000);

  // Initial dispatch.
  check();

  return () => {
    window.removeEventListener('popstate', check);
    window.removeEventListener('crunchyroll-companion:locationchange', check);
    window.clearInterval(pollId);
  };
}
