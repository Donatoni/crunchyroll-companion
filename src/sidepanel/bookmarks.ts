/**
 * Bookmarks overlay: the shows you've flagged "come back and finish this",
 * each at the latest episode you were on (the bookmark lives on the history
 * entry, so the resume point self-maintains as you watch).
 *
 * The list stays short by nature, so each entry is a big banner card: the
 * episode thumbnail as the backdrop, the MAL cover as a poster (resolved
 * lazily and cached, falling back to the thumbnail), and a play affordance.
 */
import { getBookmarks, setBookmark, type HistoryEntry } from '@/shared/history';
import { requestMalStatus } from '@/shared/messages';
import { $, makeActivatable, openEpisode, relTime, scrollPanelTop, setBg } from './helpers';

const bookmarksView = $('#bookmarksView');
const bmList = $('#bm-list');

const keyOf = (s: string) => s.trim().toLowerCase();

// ── poster enrichment ───────────────────────────────────────────────
// History stores only the episode thumbnail; the portrait cover comes from MAL.
// Resolved lazily per series and cached in storage.local so reopening is
// instant. '' means "resolved, no poster" (don't refetch); missing = unknown.
const POSTER_CACHE_KEY = 'bookmarkPosters';
let posterCache: Record<string, string> = {};
let posterFillRunning = false;

async function loadPosterCache(): Promise<void> {
  const r = await chrome.storage.local.get(POSTER_CACHE_KEY);
  posterCache = (r[POSTER_CACHE_KEY] as Record<string, string> | undefined) ?? {};
}

async function fillPosters(): Promise<void> {
  if (posterFillRunning) return;
  posterFillRunning = true;
  try {
    const items = await getBookmarks();
    for (const it of items) {
      const k = keyOf(it.series);
      if (k in posterCache) continue;
      let resolved: string | null = null;
      try {
        const r = await requestMalStatus({
          episodeId: it.episodeId,
          series: it.series,
          season: it.season,
          episode: it.episode,
          episodeTitle: it.episodeTitle,
          thumbnail: it.thumbnail,
        });
        // ok → poster; definitive "no match" carries `connected` → cache empty;
        // a bare {ok:false} is a transient error, so leave it unknown to retry.
        if (r.ok) resolved = r.picture ?? '';
        else if ('connected' in r) resolved = '';
      } catch {
        resolved = null;
      }
      if (resolved === null) continue; // transient — try again next open
      posterCache[k] = resolved;
      await chrome.storage.local.set({ [POSTER_CACHE_KEY]: posterCache });
      if (!bookmarksView.hidden) void renderBookmarks(); // upgrade cards live
      await new Promise((res) => setTimeout(res, 300)); // be gentle on the API
    }
    // Prune cache entries for shows that are no longer bookmarked.
    const live = new Set(items.map((it) => keyOf(it.series)));
    let pruned = false;
    for (const k of Object.keys(posterCache)) {
      if (!live.has(k)) {
        delete posterCache[k];
        pruned = true;
      }
    }
    if (pruned) await chrome.storage.local.set({ [POSTER_CACHE_KEY]: posterCache });
  } finally {
    posterFillRunning = false;
  }
}

// ── cards ───────────────────────────────────────────────────────────
function buildCard(it: HistoryEntry): HTMLElement {
  const card = document.createElement('div');
  card.className = 'bm-card';
  card.title = `Resume ${it.series}`;
  card.innerHTML =
    '<div class="bm-bg"></div><div class="bm-grad"></div>' +
    '<div class="bm-inner">' +
    '<div class="bm-poster"></div>' +
    '<div class="bm-main"><div class="bm-title"></div><div class="bm-sub"><span class="se"></span><span class="bm-ep"></span></div><div class="bm-when"></div></div>' +
    // Right-side column: remove-bookmark above, play below — stacked in flow so
    // they can never overlap, whatever height the title wraps to.
    '<div class="bm-side">' +
    '<span class="bm-play"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.5a1 1 0 0 1 1.5-.87l11 6.5a1 1 0 0 1 0 1.74l-11 6.5A1 1 0 0 1 7 18.5v-13Z"/></svg></span>' +
    '</div>' +
    '</div>';

  setBg(card.querySelector('.bm-bg')!, it.thumbnail);
  // Poster: MAL cover when resolved; the episode thumb (center-cropped) until then.
  setBg(card.querySelector('.bm-poster')!, posterCache[keyOf(it.series)] || it.thumbnail);
  card.querySelector<HTMLElement>('.bm-title')!.textContent = it.series;
  const se = [it.season ? `S${it.season}` : null, it.episode ? `E${it.episode}` : null]
    .filter(Boolean)
    .join(' ');
  card.querySelector<HTMLElement>('.se')!.textContent = se;
  card.querySelector<HTMLElement>('.se')!.hidden = !se;
  // textContent (not innerHTML) so episode titles can't inject markup.
  card.querySelector<HTMLElement>('.bm-ep')!.textContent = it.episodeTitle || '';
  card.querySelector<HTMLElement>('.bm-when')!.textContent = `Watched ${relTime(it.updatedAt)}`;
  makeActivatable(card, () => void openEpisode(it.url));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'bm-del';
  del.setAttribute('aria-label', `Remove bookmark for ${it.series}`);
  del.title = 'Remove bookmark';
  del.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4-6.5 4v-16a1 1 0 0 1 1-1z" fill="currentColor"/></svg>';
  // The card itself is a button — keep the remove tap from also resuming.
  del.addEventListener('keydown', (e) => e.stopPropagation());
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await setBookmark(it.series, false);
    await renderBookmarks();
  });
  card.querySelector('.bm-side')!.prepend(del);
  return card;
}

async function renderBookmarks(): Promise<void> {
  const items = await getBookmarks();
  bmList.replaceChildren();
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'bm-empty';
    e.innerHTML =
      '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4-6.5 4v-16a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<div class="bm-empty-title">No bookmarks yet</div>' +
      '<div class="bm-empty-sub">Tap the bookmark on a show you mean to come back and finish — it’ll wait here at your latest episode.</div>';
    bmList.appendChild(e);
    return;
  }
  for (const it of items) bmList.appendChild(buildCard(it));
}

$('#open-bookmarks').addEventListener('click', async () => {
  bookmarksView.hidden = false;
  await loadPosterCache();
  await renderBookmarks();
  void fillPosters(); // background: resolve missing covers, then upgrade cards
});
$('#bm-back').addEventListener('click', () => {
  bookmarksView.hidden = true;
  scrollPanelTop(); // leaving Bookmarks lands at the top of the page
});
