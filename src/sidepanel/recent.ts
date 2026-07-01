/**
 * "Recent" (continue watching) overlay: full history list with search, sort,
 * and a lazily-resolved genre filter.
 */
import { requestMalStatus } from '@/shared/messages';
import { clearHistory, getHistory, removeHistory, type HistoryEntry } from '@/shared/history';
import { $, openEpisode, relTime, setBg } from './helpers';

const recentView = $('#recentView');
const recList = $('#rec-list');
const recSearchInput = $<HTMLInputElement>('#rec-search');
const recSortSel = $<HTMLSelectElement>('#rec-sort');
const recGenreSel = $<HTMLSelectElement>('#rec-genre');

let recSearch = '';
let recSort: 'recent' | 'alpha' = 'recent';
let recGenre = '';

const keyOf = (s: string) => s.trim().toLowerCase();

/** Group label for the "Recent" sort — buckets by how long ago it was opened. */
function recentBucket(ts: number): string {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86_400_000;
  if (ts >= startToday) return 'Today';
  if (ts >= startToday - DAY) return 'Yesterday';
  if (ts >= startToday - 6 * DAY) return 'Earlier this week';
  if (ts >= startToday - 29 * DAY) return 'This month';
  return 'Older';
}

/** Group label for the "A–Z" sort — first letter, non-letters under "#". */
function alphaBucket(series: string): string {
  const c = series.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

// ── genre enrichment ────────────────────────────────────────────────
// History stores no genre (it's MAL-only), so we resolve it lazily per series
// via GET_MAL_STATUS — which returns public genres even when signed out — and
// cache the result in storage.local so reopening the panel is instant. `[]`
// means "resolved, none/unmatched" (don't refetch); a missing key means "unknown".
const GENRE_CACHE_KEY = 'historyGenres';
let genreCache: Record<string, string[]> = {};
let genreFillRunning = false;

async function loadGenreCache(): Promise<void> {
  const r = await chrome.storage.local.get(GENRE_CACHE_KEY);
  genreCache = (r[GENRE_CACHE_KEY] as Record<string, string[]> | undefined) ?? {};
}

/** Resolve genres for any history series we haven't cached yet (throttled). */
async function fillGenres(): Promise<void> {
  if (genreFillRunning) return;
  genreFillRunning = true;
  try {
    const all = await getHistory();
    for (const it of all) {
      const k = keyOf(it.series);
      if (k in genreCache) continue;
      let resolved: string[] | null = null;
      try {
        const r = await requestMalStatus({
          episodeId: it.episodeId,
          series: it.series,
          season: it.season,
          episode: it.episode,
          episodeTitle: it.episodeTitle,
          thumbnail: it.thumbnail,
        });
        // ok → genres; definitive "no match" carries `connected` → cache empty;
        // a bare {ok:false} is a transient error, so leave it unknown to retry.
        if (r.ok) resolved = r.genres ?? [];
        else if ('connected' in r) resolved = [];
      } catch {
        resolved = null;
      }
      if (resolved === null) continue; // transient — try again next open
      genreCache[k] = resolved;
      await chrome.storage.local.set({ [GENRE_CACHE_KEY]: genreCache });
      if (!recentView.hidden) void renderRecent(); // reflect new genres live
      await new Promise((res) => setTimeout(res, 300)); // be gentle on the API
    }
    // Prune cache entries for series no longer in history.
    const live = new Set(all.map((it) => keyOf(it.series)));
    let pruned = false;
    for (const k of Object.keys(genreCache)) {
      if (!live.has(k)) {
        delete genreCache[k];
        pruned = true;
      }
    }
    if (pruned) await chrome.storage.local.set({ [GENRE_CACHE_KEY]: genreCache });
  } finally {
    genreFillRunning = false;
  }
}

/** Rebuild the genre dropdown from every genre known across the full history. */
function rebuildGenreOptions(all: HistoryEntry[]): void {
  const set = new Set<string>();
  for (const it of all) for (const g of genreCache[keyOf(it.series)] ?? []) set.add(g);
  const genres = [...set].sort((a, b) => a.localeCompare(b));
  recGenreSel.hidden = genres.length === 0;
  if (recGenre && !genres.includes(recGenre)) recGenre = ''; // selected genre vanished
  recGenreSel.replaceChildren();
  const all0 = document.createElement('option');
  all0.value = '';
  all0.textContent = 'All genres';
  recGenreSel.appendChild(all0);
  for (const g of genres) {
    const o = document.createElement('option');
    o.value = g;
    o.textContent = g;
    recGenreSel.appendChild(o);
  }
  recGenreSel.value = recGenre;
}

function buildRow(it: HistoryEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rec-item';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'rec-open';
  open.innerHTML = `<div class="rec-thumb"></div><div class="rec-main"><div class="rec-series"></div><div class="rec-sub"><span class="se"></span><span class="rec-eptitle"></span></div></div><span class="rec-time"></span>`;
  setBg(open.querySelector('.rec-thumb')!, it.thumbnail);
  open.querySelector<HTMLElement>('.rec-series')!.textContent = it.series;
  const se = [it.season ? `S${it.season}` : null, it.episode ? `E${it.episode}` : null]
    .filter(Boolean)
    .join(' ');
  open.querySelector<HTMLElement>('.se')!.textContent = se;
  // textContent (not innerHTML) so episode titles can't inject markup.
  open.querySelector<HTMLElement>('.rec-eptitle')!.textContent = it.episodeTitle
    ? `${se ? ' · ' : ''}${it.episodeTitle}`
    : '';
  open.querySelector<HTMLElement>('.rec-time')!.textContent = relTime(it.updatedAt);
  open.addEventListener('click', () => void openEpisode(it.url));
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'rec-del';
  del.setAttribute('aria-label', `Remove ${it.series}`);
  del.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  del.addEventListener('click', async () => {
    await removeHistory(it.series);
    await renderRecent();
  });
  row.append(open, del);
  return row;
}

async function renderRecent(): Promise<void> {
  const all: HistoryEntry[] = await getHistory();
  rebuildGenreOptions(all);
  recList.replaceChildren();

  if (!all.length) {
    const e = document.createElement('div');
    e.className = 'rec-empty';
    e.textContent = 'Nothing yet — episodes you open show up here.';
    recList.appendChild(e);
    return;
  }

  const q = recSearch.trim().toLowerCase();
  let items = all.filter((it) => {
    if (q && !`${it.series} ${it.episodeTitle ?? ''}`.toLowerCase().includes(q)) return false;
    if (recGenre && !(genreCache[keyOf(it.series)] ?? []).includes(recGenre)) return false;
    return true;
  });
  // getHistory() is already newest-first; only re-sort for A–Z.
  if (recSort === 'alpha') {
    items = [...items].sort((a, b) => a.series.localeCompare(b.series));
  }

  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'rec-empty';
    e.textContent = 'No shows match your search or filters.';
    recList.appendChild(e);
    return;
  }

  let lastGroup = '';
  for (const it of items) {
    const group = recSort === 'alpha' ? alphaBucket(it.series) : recentBucket(it.updatedAt);
    if (group !== lastGroup) {
      lastGroup = group;
      const h = document.createElement('div');
      h.className = 'rec-group';
      h.textContent = group;
      recList.appendChild(h);
    }
    recList.appendChild(buildRow(it));
  }
}

recSearchInput.addEventListener('input', () => {
  recSearch = recSearchInput.value;
  void renderRecent();
});
recSortSel.addEventListener('change', () => {
  recSort = recSortSel.value === 'alpha' ? 'alpha' : 'recent';
  void renderRecent();
});
recGenreSel.addEventListener('change', () => {
  recGenre = recGenreSel.value;
  void renderRecent();
});

$('#open-recent').addEventListener('click', async () => {
  recentView.hidden = false;
  await loadGenreCache();
  await renderRecent();
  void fillGenres(); // background: resolve any missing genres, then re-render
});
$('#rec-back').addEventListener('click', () => (recentView.hidden = true));
$('#rec-clear').addEventListener('click', async () => {
  await clearHistory();
  await renderRecent();
});
