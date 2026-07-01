/**
 * Watching view: hero, MAL show details (synopsis/genres/seasons/characters/
 * reviews), the Your-list card with inline episode/status/score controls, and
 * the two-way progress reconciliation banner.
 */
import type { TrackerMeta } from '@/shared/types';
import {
  requestMalStatus,
  setMalStatus,
  requestMalCharacters,
  requestMalReviews,
  type MalStatusResponse,
} from '@/shared/messages';
import type { MalCharacter, MalRelated, MalReview } from '@/shared/mal';
import { $, esc, makeActivatable, makeRailScrollable, setBg } from './helpers';
import { openSettings } from './settings-view';

const MAL_STATUS = [
  { value: 'watching', label: 'Watching', dot: '#3aa0ff' },
  { value: 'completed', label: 'Completed', dot: '#34d27b' },
  { value: 'on_hold', label: 'On hold', dot: '#f0b429' },
  { value: 'dropped', label: 'Dropped', dot: '#f0596b' },
  { value: 'plan_to_watch', label: 'Plan to watch', dot: '#9b9ba3' },
];

type MalPatch = {
  num_watched_episodes?: number;
  status?: string;
  score?: number;
  is_rewatching?: boolean;
};

// ── state ───────────────────────────────────────────────────────────
let currentMeta: TrackerMeta | null = null;
let malResp: MalStatusResponse | undefined;
let malTotal: number | null = null;
let lastMetaKey = '';
let lastCharId: number | null = null;
const charCache = new Map<number, MalCharacter[]>();
let lastReviewId: number | null = null;
const reviewCache = new Map<number, { reviews: MalReview[]; allUrl: string }>();

// ── elements ────────────────────────────────────────────────────────
const heroBg = $('#heroBg');
const poster = $('#poster');
const heroTitle = $('#heroTitle');
const heroSE = $('#heroSE');
const heroEpTitle = $('#heroEpTitle');
const metaStrip = $('#metaStrip');
const genresEl = $('#genres');
const synopsisWrap = $('#synopsisWrap');
const synopsisEl = $('#synopsis');
const synMore = $('#synMore');
const detailsSkel = $('#detailsSkel');

const malSynced = $('#malSynced');
const malCard = $('#malCard');
const malNudge = $('#malNudge');
const malNote = $('#malNote');
const malErr = $('#malErr');
const progNow = $('#progNow');
const progTotal = $('#progTotal');
const progPct = $('#progPct');
const progBar = $('#progBar');
const epVal = $('#epVal');
const epMinus = $<HTMLButtonElement>('#epMinus');
const epPlus = $<HTMLButtonElement>('#epPlus');
const statusBtn = $<HTMLButtonElement>('#statusBtn');
const statusMenu = $('#statusMenu');
const statusLabel = $('#statusLabel');
const statusDot = $('#statusDot');
const scoreBtn = $<HTMLButtonElement>('#scoreBtn');
const scoreMenu = $('#scoreMenu');
const malLink = $<HTMLAnchorElement>('#malLink');
const malReconcile = $<HTMLButtonElement>('#malReconcile');
const reconcileIc = $('#reconcileIc');
const reconcileTitle = $('#reconcileTitle');
const reconcileSub = $('#reconcileSub');
const reconcileCta = $('#reconcileCta');

const seasonsSection = $('#seasonsSection');
const seasonsRail = $('#seasonsRail');
const charactersSection = $('#charactersSection');
const charactersRail = $('#charactersRail');
const reviewsSection = $('#reviewsSection');
const reviewsList = $('#reviewsList');

[seasonsRail, charactersRail].forEach(makeRailScrollable);

// ── helpers ─────────────────────────────────────────────────────────
function metaKey(m: TrackerMeta): string {
  return `${m.series}|${m.season}|${m.episode}`;
}

// ── hero ────────────────────────────────────────────────────────────
function renderHero(): void {
  if (!currentMeta) return;
  setBg(heroBg, currentMeta.thumbnail);
  // Poster: show ONLY the MAL cover. While MAL is still loading (malResp
  // undefined) leave it blank rather than flashing the Crunchyroll thumbnail
  // and then swapping. Fall back to the CR thumbnail only once MAL has resolved
  // with no image of its own (no match), so we never show CR → MAL.
  setBg(poster, malResp ? malResp.picture || currentMeta.thumbnail : null);
  poster.classList.toggle('skel-shimmer', !malResp);
  heroTitle.textContent = currentMeta.series;
  const se = [
    currentMeta.season ? `S${currentMeta.season}` : null,
    currentMeta.episode ? `E${currentMeta.episode}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  heroSE.textContent = se;
  heroSE.hidden = !se;
  heroEpTitle.textContent = currentMeta.episodeTitle ? ` ${currentMeta.episodeTitle}` : '';
}

// ── show details (from MAL) ─────────────────────────────────────────
function hideDetails(): void {
  metaStrip.hidden = true;
  genresEl.hidden = true;
  synopsisWrap.hidden = true;
  seasonsSection.hidden = true;
}

function renderDetails(r: MalStatusResponse): void {
  // meta strip
  const bits: Array<HTMLElement> = [];
  const stat = (html: string) => {
    const s = document.createElement('span');
    s.className = 'stat';
    // eslint-disable-next-line no-unsanitized/property -- every call site below interpolates only esc()'d values or literals
    s.innerHTML = html;
    return s;
  };
  if (r.mean) bits.push(stat(`<span class="star">★</span><b>${esc(r.mean.toFixed(2))}</b>`));
  if (r.mediaType) bits.push(stat(esc(r.mediaType.toUpperCase())));
  if (r.total) bits.push(stat(`<b>${esc(r.total)}</b>&nbsp;eps`));
  if (r.year) bits.push(stat(esc(r.year)));
  if (r.studios && r.studios.length) bits.push(stat(esc(r.studios[0])));
  metaStrip.replaceChildren();
  bits.forEach((b, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'dot-sep';
      metaStrip.appendChild(sep);
    }
    metaStrip.appendChild(b);
  });
  metaStrip.hidden = bits.length === 0;

  // genres
  genresEl.replaceChildren();
  for (const g of r.genres ?? []) {
    const el = document.createElement('span');
    el.className = 'genre';
    el.textContent = g;
    genresEl.appendChild(el);
  }
  genresEl.hidden = !(r.genres && r.genres.length);

  // synopsis
  const syn = (r.synopsis ?? '').trim();
  synopsisEl.textContent = syn;
  synopsisEl.classList.add('clamp');
  synMore.textContent = 'Read more';
  synMore.setAttribute('aria-expanded', 'false');
  synopsisWrap.hidden = !syn;
  // Only offer "Read more" when the text actually overflows the 4-line clamp.
  // Measure on the next frame so layout has settled.
  synMore.hidden = true;
  if (syn) {
    requestAnimationFrame(() => {
      synMore.hidden = synopsisEl.scrollHeight <= synopsisEl.clientHeight;
    });
  }

  // seasons / related
  renderSeasons(r.related ?? []);
}

synMore.addEventListener('click', () => {
  const clamped = synopsisEl.classList.toggle('clamp');
  synMore.textContent = clamped ? 'Read more' : 'Show less';
  synMore.setAttribute('aria-expanded', String(!clamped));
});

function renderSeasons(related: MalRelated[]): void {
  const items = related.filter((r) => r.title);
  seasonsRail.replaceChildren();
  if (currentMeta && malResp?.animeId && malResp.title) {
    // current show first
    const cur = document.createElement('div');
    cur.className = 'season cur';
    cur.innerHTML = '<div class="ph"></div><div class="t"></div><div class="n"></div>';
    setBg(cur.querySelector('.ph')!, malResp.picture);
    cur.querySelector<HTMLElement>('.t')!.textContent = malResp.title;
    cur.querySelector<HTMLElement>('.n')!.textContent =
      (malResp.mediaType ? malResp.mediaType.toUpperCase() : '') +
      (malResp.total ? ` · ${malResp.total}` : '');
    seasonsRail.appendChild(cur);
  }
  for (const r of items) {
    const el = document.createElement('div');
    el.className = 'season';
    el.innerHTML = '<div class="ph"></div><div class="t"></div><div class="n"></div>';
    setBg(el.querySelector('.ph')!, r.picture);
    el.querySelector<HTMLElement>('.t')!.textContent = r.title;
    el.querySelector<HTMLElement>('.n')!.textContent = r.relation || (r.mediaType ?? '');
    el.title = `${r.title}${r.relation ? ' — ' + r.relation : ''}`;
    makeActivatable(el, () => {
      window.open(`https://myanimelist.net/anime/${r.id}`, '_blank', 'noopener');
    });
    seasonsRail.appendChild(el);
  }
  seasonsSection.hidden = seasonsRail.children.length === 0;
}

async function loadCharacters(animeId: number): Promise<void> {
  if (animeId === lastCharId) return;
  lastCharId = animeId;
  charactersSection.hidden = true;
  let chars = charCache.get(animeId);
  if (!chars) {
    try {
      const r = await requestMalCharacters(animeId);
      chars = r.ok ? r.characters : [];
      charCache.set(animeId, chars);
    } catch {
      chars = [];
    }
  }
  if (animeId !== lastCharId) return; // changed while loading
  charactersRail.replaceChildren();
  for (const c of chars) {
    const el = document.createElement('div');
    el.className = 'char';
    el.innerHTML = '<div class="av"></div><div class="cn"></div><div class="cr"></div>';
    setBg(el.querySelector('.av')!, c.image);
    el.querySelector<HTMLElement>('.cn')!.textContent = c.name;
    el.querySelector<HTMLElement>('.cr')!.textContent = (c.role || '').toUpperCase();
    charactersRail.appendChild(el);
  }
  charactersSection.hidden = chars.length === 0;
}

function reviewTagClass(tag: string): string {
  const t = tag.toLowerCase();
  if (t.includes('not')) return 'not';
  if (t.includes('mixed')) return 'mixed';
  if (t.includes('recommend')) return 'rec';
  return '';
}

async function loadReviews(animeId: number): Promise<void> {
  if (animeId === lastReviewId) return;
  lastReviewId = animeId;
  reviewsSection.hidden = true;
  let data = reviewCache.get(animeId);
  if (!data) {
    try {
      const r = await requestMalReviews(animeId);
      data = { reviews: r.ok ? r.reviews : [], allUrl: r.allUrl ?? '' };
      reviewCache.set(animeId, data);
    } catch {
      data = { reviews: [], allUrl: '' };
    }
  }
  if (animeId !== lastReviewId) return;
  reviewsList.replaceChildren();
  for (const rv of data.reviews) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'review';
    const top = document.createElement('div');
    top.className = 'review-top';
    top.innerHTML = '<div class="review-av"></div><span class="review-user"></span>';
    setBg(top.querySelector('.review-av')!, rv.avatar);
    top.querySelector<HTMLElement>('.review-user')!.textContent = rv.user;
    if (rv.score) {
      const score = document.createElement('span');
      score.className = 'review-score';
      score.innerHTML = '<span style="color:#ffc24b">★</span>';
      score.append(String(rv.score));
      top.appendChild(score);
    }
    if (rv.tag) {
      const tag = document.createElement('span');
      tag.className = `review-tag ${reviewTagClass(rv.tag)}`;
      tag.textContent = rv.tag;
      top.appendChild(tag);
    }
    const text = document.createElement('div');
    text.className = 'review-text';
    text.textContent = rv.text;
    const more = document.createElement('div');
    more.className = 'review-more';
    more.textContent = 'Read full review →';
    card.append(top, text, more);
    if (rv.url) makeActivatable(card, () => window.open(rv.url, '_blank', 'noopener'));
    reviewsList.appendChild(card);
  }
  if (data.reviews.length && data.allUrl) {
    const all = document.createElement('a');
    all.className = 'reviews-all';
    all.href = data.allUrl;
    all.target = '_blank';
    all.rel = 'noopener';
    all.textContent = 'View all reviews on MyAnimeList →';
    reviewsList.appendChild(all);
  }
  reviewsSection.hidden = data.reviews.length === 0;
}

// ── your list (MAL controls) ────────────────────────────────────────
function setStatusControl(value: string): void {
  const opt = MAL_STATUS.find((o) => o.value === value) ?? MAL_STATUS[0];
  statusLabel.textContent = opt.label;
  statusDot.style.background = opt.dot;
  for (const el of statusMenu.querySelectorAll<HTMLElement>('.dd-opt')) {
    const sel = el.dataset.value === opt.value;
    el.classList.toggle('sel', sel);
    el.setAttribute('aria-checked', String(sel));
  }
}
function setScoreControl(value: number): void {
  // Five stars represent the 1–10 scale with HALF-star precision (e.g. 7 → 3½),
  // plus the exact number so it's unambiguous. The 1–10 grid (on click) sets it.
  scoreBtn.replaceChildren();
  const row = document.createElement('span');
  row.className = 'star-row';
  for (let i = 1; i <= 5; i++) {
    const fill = Math.max(0, Math.min(1, value / 2 - (i - 1)));
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = '★';
    const f = document.createElement('span');
    f.className = 'fill';
    f.textContent = '★';
    f.style.width = `${fill * 100}%`;
    s.appendChild(f);
    row.appendChild(s);
  }
  const num = document.createElement('span');
  num.className = 'score-num';
  if (value) {
    num.append(String(value));
    const max = document.createElement('span');
    max.className = 'max';
    max.textContent = '/10';
    num.appendChild(max);
  } else {
    num.textContent = '–';
  }
  scoreBtn.append(row, num);
  for (const el of scoreMenu.querySelectorAll<HTMLElement>('.score-cell')) {
    const sel = Number(el.dataset.score) === value;
    el.classList.toggle('sel', sel);
    el.setAttribute('aria-checked', String(sel));
  }
}

/**
 * Two-way progress reconciliation: when the episode you're on in Crunchyroll and
 * the count on MyAnimeList disagree, surface a one-tap fix.
 * - CR ahead by exactly 1 is the natural "watching the next episode right now"
 *   state — progress-sync pushes it to MAL after ~30s of playback — so prompting
 *   would nag on every episode (and on E1 of a show you haven't started, where
 *   MAL is rightly 0). Only offer forward catch-up for gaps of 2+.
 * - Backward: don't offer to LOWER a completed entry — opening an old episode of
 *   a finished show is a casual revisit, not a sign your count is wrong.
 */
function renderReconcile(): void {
  const cr = currentMeta?.episode ?? null;
  const mal = malResp?.watched ?? null;
  const crAhead = cr != null && mal != null && cr > mal + 1;
  const malAhead =
    cr != null && mal != null && mal > cr && malResp?.status !== 'completed';
  const show = !!(malResp?.ok && malResp?.connected) && cr != null && cr > 0 && (crAhead || malAhead);
  malReconcile.hidden = !show;
  if (!show || cr == null || mal == null) return;

  const ahead = cr > mal;
  reconcileIc.textContent = ahead ? '↑' : '↓';
  reconcileTitle.textContent = ahead ? 'Crunchyroll is ahead' : 'MyAnimeList is ahead';
  reconcileSub.textContent = ahead
    ? `You're on E${cr} · MAL has ${mal}`
    : `MAL has ${mal} · you're on E${cr}`;
  reconcileCta.textContent = ahead ? `Update to E${cr}` : `Set to E${cr}`;
  // Backward edits lower the count — mark them cautionary.
  malReconcile.classList.toggle('caution', !ahead);
  malReconcile.onclick = () => void saveMal(episodeEditPatch(cr));
}

function applyMal(r: MalStatusResponse | undefined): void {
  malResp = r;
  malErr.hidden = true;
  malErr.replaceChildren();
  detailsSkel.hidden = true;
  const matched = !!r?.ok;

  // Show details (synopsis / genres / seasons / characters) whenever we matched
  // a show — signed in or not. The public data comes back via the client-id.
  if (matched && r) {
    renderHero(); // poster may now be available
    renderDetails(r);
    if (r.animeId) {
      malLink.href = `https://myanimelist.net/anime/${r.animeId}`;
      void loadCharacters(r.animeId);
      void loadReviews(r.animeId);
    }
  } else {
    renderHero(); // clear the poster shimmer even when nothing matched
    hideDetails();
    charactersSection.hidden = true;
    reviewsSection.hidden = true;
  }

  // Your-list card (signed in + matched) vs nudge (not signed in) vs note.
  if (matched && r?.connected) {
    malNudge.hidden = true;
    malNote.hidden = true;
    malSynced.hidden = false;
    malCard.hidden = false;
    malTotal = r.total ?? null;
    const watched = r.watched ?? 0;
    progNow.textContent = String(watched);
    progTotal.textContent = r.total ? `/ ${r.total} episodes` : 'episodes';
    const pct = r.total ? Math.round((watched / r.total) * 100) : 0;
    progBar.style.width = `${Math.min(100, pct)}%`;
    progPct.textContent = r.total ? `${Math.min(100, pct)}%` : '';
    epVal.textContent = String(watched);
    epMinus.disabled = watched <= 0;
    epPlus.disabled = malTotal != null && watched >= malTotal;
    setStatusControl(r.status ?? 'watching');
    setScoreControl(r.score ?? 0);
    renderReconcile();
  } else if (!r?.connected) {
    // Not signed in — invite to connect (details above still render).
    malCard.hidden = true;
    malNote.hidden = true;
    malSynced.hidden = true;
    malNudge.hidden = false;
  } else {
    // Signed in but no match.
    malCard.hidden = true;
    malNudge.hidden = true;
    malSynced.hidden = true;
    malNote.hidden = false;
    malNote.textContent = "Couldn't match this show on MyAnimeList yet.";
  }
}

/** Transient failure (network / worker error): keep the view, offer a retry. */
function showMalRetry(): void {
  detailsSkel.hidden = true;
  poster.classList.remove('skel-shimmer');
  malErr.replaceChildren();
  const msg = document.createElement('span');
  msg.textContent = "Couldn't reach MyAnimeList. ";
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'mal-retry';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => {
    lastMetaKey = ''; // force a refetch for the current show
    if (currentMeta) updateWatching(currentMeta);
  });
  malErr.append(msg, retry);
  malErr.hidden = false;
}

async function loadMal(): Promise<void> {
  if (!currentMeta) return;
  const key = metaKey(currentMeta); // the show this request is for
  try {
    const r = await requestMalStatus(currentMeta);
    if (lastMetaKey !== key) return; // show changed during the await — drop stale response
    // `connected` missing on a not-ok response means the worker itself errored
    // (transient), not a definitive "no match" — offer a retry instead of the
    // misleading "connect MAL" nudge.
    if (!r?.ok && r?.connected === undefined) showMalRetry();
    else applyMal(r);
  } catch {
    if (lastMetaKey !== key) return;
    showMalRetry();
  }
}

async function saveMal(patch: MalPatch): Promise<void> {
  if (!currentMeta) return;
  const key = metaKey(currentMeta); // the show this save is for
  malErr.hidden = true;
  malCard.style.opacity = '0.5';
  try {
    const r = await setMalStatus(currentMeta, patch);
    if (lastMetaKey !== key) return; // show changed during the await — don't clobber it
    if (r?.ok) {
      // SET response lacks rich details — merge so we keep synopsis/seasons/etc.
      applyMal({ ...malResp, ...r });
    } else {
      malErr.textContent = r?.error ? `Couldn't save: ${r.error}` : "Couldn't save to MAL";
      malErr.hidden = false;
    }
  } catch {
    malErr.textContent = "Couldn't reach MAL";
    malErr.hidden = false;
  } finally {
    malCard.style.opacity = '1';
  }
}

/**
 * Build the patch for a manual episode-count edit, including any status flip:
 *  - reaching the finale marks the entry COMPLETED, and
 *  - dropping below the finale un-completes it (back to WATCHING) instead of
 *    leaving a contradictory "completed" entry with watched < total.
 */
function episodeEditPatch(n: number): MalPatch {
  const patch: MalPatch = { num_watched_episodes: n };
  if (malTotal && n >= malTotal) {
    patch.status = 'completed';
  } else if (malResp?.status === 'completed') {
    patch.status = 'watching';
  }
  return patch;
}

epMinus.addEventListener('click', () => {
  const cur = Number(epVal.textContent) || 0;
  if (cur > 0) void saveMal(episodeEditPatch(cur - 1));
});
epPlus.addEventListener('click', () => {
  const cur = Number(epVal.textContent) || 0;
  void saveMal(episodeEditPatch(cur + 1));
});

// Type an episode directly into the field.
epVal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    epVal.blur();
  } else if (e.key === 'Escape') {
    epVal.textContent = String(malResp?.watched ?? 0);
    epVal.blur();
  }
});
epVal.addEventListener('focus', () => {
  const range = document.createRange();
  range.selectNodeContents(epVal);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
});
epVal.addEventListener('blur', () => {
  const cur = malResp?.watched ?? 0;
  const raw = (epVal.textContent || '').replace(/[^0-9]/g, '');
  let n = raw === '' ? cur : parseInt(raw, 10);
  if (malTotal != null) n = Math.min(n, malTotal);
  n = Math.max(0, n);
  epVal.textContent = String(n);
  if (n !== cur) void saveMal(episodeEditPatch(n));
});

// status dropdown (built once)
for (const o of MAL_STATUS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dd-opt';
  b.setAttribute('role', 'menuitemradio');
  b.setAttribute('aria-checked', 'false');
  b.dataset.value = o.value;
  b.innerHTML =
    `<span class="dd-dot" style="background:${esc(o.dot)}"></span>${esc(o.label)}` +
    '<svg class="check" width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5 9-10" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round"/></svg>';
  b.addEventListener('click', () => {
    closeMenus();
    const patch: MalPatch = { status: o.value };
    if (o.value === 'completed' && malTotal) {
      patch.num_watched_episodes = malTotal;
    } else if (o.value === 'watching') {
      const ep = currentMeta?.episode;
      if (ep && ep > 0) {
        patch.num_watched_episodes = ep;
        patch.is_rewatching = false;
      }
    }
    void saveMal(patch);
  });
  statusMenu.appendChild(b);
}
statusMenu.querySelectorAll<HTMLElement>('.check').forEach((c) => (c.style.display = 'none'));

// score grid (built once)
const grid = document.createElement('div');
grid.className = 'score-grid';
for (let n = 1; n <= 10; n++) {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'score-cell';
  c.setAttribute('role', 'menuitemradio');
  c.setAttribute('aria-checked', 'false');
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
  statusMenu.hidden = true;
  scoreMenu.hidden = true;
  statusBtn.setAttribute('aria-expanded', 'false');
  scoreBtn.setAttribute('aria-expanded', 'false');
}
function toggleMenu(menu: HTMLElement, trigger: HTMLButtonElement): void {
  const willOpen = menu.hidden;
  closeMenus();
  if (willOpen) {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    statusMenu.querySelectorAll<HTMLElement>('.dd-opt').forEach((el) => {
      const chk = el.querySelector<HTMLElement>('.check');
      if (chk) chk.style.display = el.classList.contains('sel') ? '' : 'none';
    });
  }
}
statusBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(statusMenu, statusBtn); });
scoreBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(scoreMenu, scoreBtn); });
document.addEventListener('click', closeMenus);
// Escape closes whichever menu is open and returns focus to its trigger.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!statusMenu.hidden) {
    closeMenus();
    statusBtn.focus();
  } else if (!scoreMenu.hidden) {
    closeMenus();
    scoreBtn.focus();
  }
});
malNudge.addEventListener('click', openSettings);

// ── public API (called by the shell) ────────────────────────────────
/** Render the watching view for the tab's current episode metadata. */
export function updateWatching(meta: TrackerMeta): void {
  currentMeta = meta;
  const key = metaKey(meta);
  if (key !== lastMetaKey) {
    lastMetaKey = key;
    malResp = undefined; // new show: drop stale MAL data so the poster waits for the new cover
    detailsSkel.hidden = false; // shimmer until MAL details resolve
    void loadMal();
  }
  renderHero();
}

/** Forget the cached show so the next updateWatching() re-fetches from MAL. */
export function resetWatchingCache(): void {
  lastMetaKey = '';
  currentMeta = null;
}
