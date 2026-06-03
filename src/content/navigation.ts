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
 * Extract the episode id from a /watch/{episodeId}/slug URL.
 *
 * The actual <video> lives in a cross-origin player iframe whose own URL has no
 * episode id — but the parent watch page is its `document.referrer`, so we fall
 * back to that. This lets the seek engine work from inside the iframe (where it
 * can reach the video). If the referrer is stripped, we return null and the DOM
 * fallback (clicking the native skip button) takes over.
 */
export function parseEpisode(url: string = location.href): EpisodeContext | null {
  return matchWatch(url) ?? (document.referrer ? matchWatch(document.referrer) : null);
}

type Handler = (ctx: EpisodeContext | null) => void;

let patched = false;
function patchHistory(onChange: () => void): void {
  if (patched) return;
  patched = true;
  const fire = () => window.dispatchEvent(new Event('crunchy-companion:locationchange'));
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args);
      fire();
      return result;
    };
  }
  window.addEventListener('crunchy-companion:locationchange', onChange);
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
    window.removeEventListener('crunchy-companion:locationchange', check);
    window.clearInterval(pollId);
  };
}
