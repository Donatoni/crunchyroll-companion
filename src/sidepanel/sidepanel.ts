import {
  getSettings,
  patchSettings,
  onSettingsChanged,
  type Settings,
  type SkipMode,
} from '@/shared/settings';
import type { SkipType, TrackerMeta } from '@/shared/types';
import {
  requestMalStatus,
  setMalStatus,
  requestMalCharacters,
  requestMalReviews,
  requestMyList,
  requestSeasonal,
} from '@/shared/messages';
import type {
  ContentStatusRequest,
  MalStatusResponse,
  TabStatusResponse,
} from '@/shared/messages';
import type { MalCharacter, MalRelated, MalReview } from '@/shared/mal';
import { authorizeUrl, exchangeCode, getUserName, randomVerifier } from '@/shared/mal';
import { formatSaved, getStats, lastNDays } from '@/shared/stats';
import { clearHistory, getHistory, removeHistory, type HistoryEntry } from '@/shared/history';
import {
  clearToken,
  getMappings,
  getTokenData,
  removeMapping,
  setMapping,
  setTokenData,
} from '@/shared/tracker-store';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Escape a value for safe interpolation into an innerHTML string. */
const esc = (v: unknown): string =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string),
  );

const MAL_STATUS = [
  { value: 'watching', label: 'Watching', dot: '#3aa0ff' },
  { value: 'completed', label: 'Completed', dot: '#34d27b' },
  { value: 'on_hold', label: 'On hold', dot: '#f0b429' },
  { value: 'dropped', label: 'Dropped', dot: '#f0596b' },
  { value: 'plan_to_watch', label: 'Plan to watch', dot: '#9b9ba3' },
];
const SKIP_SEGMENTS: SkipType[] = ['intro', 'recap', 'credits', 'preview'];

type MalPatch = {
  num_watched_episodes?: number;
  status?: string;
  score?: number;
  is_rewatching?: boolean;
};

// ── state ───────────────────────────────────────────────────────────
let settings: Settings | null = null;
let currentMeta: TrackerMeta | null = null;
let malResp: MalStatusResponse | undefined;
let malTotal: number | null = null;
let lastMetaKey = '';
let lastCharId: number | null = null;
const charCache = new Map<number, MalCharacter[]>();
let lastReviewId: number | null = null;
const reviewCache = new Map<number, { reviews: MalReview[]; allUrl: string }>();

// ── elements ────────────────────────────────────────────────────────
const watchingView = $('#watchingView');
const idleView = $('#idleView');

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

const seasonsSection = $('#seasonsSection');
const seasonsRail = $('#seasonsRail');
const charactersSection = $('#charactersSection');
const charactersRail = $('#charactersRail');
const reviewsSection = $('#reviewsSection');
const reviewsList = $('#reviewsList');

const idleHistorySection = $('#idleHistorySection');
const idleHistory = $('#idleHistory');
const runTime = $('#runTime');
const runDesc = $('#runDesc');
const runBars = $('#runBars');
const runTotal = $('#runTotal');
const runSegments = $('#runSegments');
const runShows = $('#runShows');
const resumeCard = $<HTMLButtonElement>('#resumeCard');
const resumeThumb = $('#resumeThumb');
const resumeTitle = $('#resumeTitle');
const resumeSub = $('#resumeSub');
const myListSection = $('#myListSection');
const myListRail = $('#myListRail');
const seasonalSection = $('#seasonalSection');
const seasonalRail = $('#seasonalRail');

// ── helpers ─────────────────────────────────────────────────────────
function metaKey(m: TrackerMeta): string {
  return `${m.series}|${m.season}|${m.episode}`;
}
function setBg(el: HTMLElement, url: string | null | undefined): void {
  if (!url) {
    el.style.backgroundImage = '';
    return;
  }
  // Strip characters that could break out of the CSS string / url() wrapper.
  const safe = url.replace(/["\\\n\r()]/g, '');
  el.style.backgroundImage = `url("${safe}")`;
}

/** Make a non-button element (a card <div>) keyboard-activatable. */
function makeActivatable(el: HTMLElement, onActivate: () => void): void {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.addEventListener('click', onActivate);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate();
    }
  });
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
    s.innerHTML = html;
    return s;
  };
  if (r.mean) bits.push(stat(`<span class="star">★</span><b>${r.mean.toFixed(2)}</b>`));
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
});

function renderSeasons(related: MalRelated[]): void {
  const items = related.filter((r) => r.title);
  seasonsRail.replaceChildren();
  if (currentMeta && malResp?.animeId && malResp.title) {
    // current show first
    const cur = document.createElement('div');
    cur.className = 'season cur';
    cur.innerHTML =
      `<div class="ph"></div><div class="t"></div><div class="n">${
        malResp.mediaType ? esc(malResp.mediaType.toUpperCase()) : ''
      }${malResp.total ? ' · ' + esc(malResp.total) : ''}</div>`;
    setBg(cur.querySelector('.ph')!, malResp.picture);
    cur.querySelector<HTMLElement>('.t')!.textContent = malResp.title;
    seasonsRail.appendChild(cur);
  }
  for (const r of items) {
    const el = document.createElement('div');
    el.className = 'season';
    el.innerHTML =
      `<div class="ph"></div><div class="t"></div><div class="n">${esc(r.relation || (r.mediaType ?? ''))}</div>`;
    setBg(el.querySelector('.ph')!, r.picture);
    el.querySelector<HTMLElement>('.t')!.textContent = r.title;
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
    el.innerHTML = `<div class="av"></div><div class="cn"></div><div class="cr">${esc((c.role || '').toUpperCase())}</div>`;
    setBg(el.querySelector('.av')!, c.image);
    el.querySelector<HTMLElement>('.cn')!.textContent = c.name;
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
    const tagCls = reviewTagClass(rv.tag);
    const top = document.createElement('div');
    top.className = 'review-top';
    top.innerHTML =
      `<div class="review-av"></div><span class="review-user"></span>` +
      (rv.score ? `<span class="review-score"><span style="color:#ffc24b">★</span>${esc(rv.score)}</span>` : '') +
      (rv.tag ? `<span class="review-tag ${tagCls}">${esc(rv.tag)}</span>` : '');
    setBg(top.querySelector('.review-av')!, rv.avatar);
    top.querySelector<HTMLElement>('.review-user')!.textContent = rv.user;
    const text = document.createElement('div');
    text.className = 'review-text';
    text.textContent = rv.text;
    const more = document.createElement('div');
    more.className = 'review-more';
    more.textContent = 'Read full review →';
    card.append(top, text, more);
    if (rv.url) card.addEventListener('click', () => window.open(rv.url, '_blank', 'noopener'));
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
    el.classList.toggle('sel', el.dataset.value === opt.value);
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
  num.innerHTML = value ? `${value}<span class="max">/10</span>` : '–';
  scoreBtn.append(row, num);
  for (const el of scoreMenu.querySelectorAll<HTMLElement>('.score-cell')) {
    el.classList.toggle('sel', Number(el.dataset.score) === value);
  }
}

function applyMal(r: MalStatusResponse | undefined): void {
  malResp = r;
  malErr.hidden = true;
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

async function loadMal(): Promise<void> {
  if (!currentMeta) return;
  const key = metaKey(currentMeta); // the show this request is for
  try {
    const r = await requestMalStatus(currentMeta);
    if (lastMetaKey !== key) return; // show changed during the await — drop stale response
    applyMal(r);
  } catch {
    if (lastMetaKey !== key) return;
    applyMal({ ok: false, connected: false });
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
  b.dataset.value = o.value;
  b.innerHTML =
    `<span class="dd-dot" style="background:${o.dot}"></span>${o.label}` +
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
}
function toggleMenu(menu: HTMLElement): void {
  const willOpen = menu.hidden;
  closeMenus();
  if (willOpen) {
    menu.hidden = false;
    statusMenu.querySelectorAll<HTMLElement>('.dd-opt').forEach((el) => {
      const chk = el.querySelector<HTMLElement>('.check');
      if (chk) chk.style.display = el.classList.contains('sel') ? '' : 'none';
    });
  }
}
statusBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(statusMenu); });
scoreBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(scoreMenu); });
document.addEventListener('click', closeMenus);
malNudge.addEventListener('click', openSettings);

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
  if (!settings) settings = await getSettings().catch(() => settings);
  await getTabStatus();

  if (currentMeta) {
    idleView.hidden = true;
    watchingView.hidden = false;
    const key = metaKey(currentMeta);
    if (key !== lastMetaKey) {
      lastMetaKey = key;
      malResp = undefined; // new show: drop stale MAL data so the poster waits for the new cover
      void loadMal();
    }
    renderHero();
  } else {
    watchingView.hidden = true;
    idleView.hidden = false;
    lastMetaKey = '';
    void renderRun();
    void renderResume();
    void renderIdleHistory();
    loadHomeContent();
  }
}

// ── idle / continue watching ────────────────────────────────────────
async function renderIdleHistory(): Promise<void> {
  const items = await getHistory();
  idleHistory.replaceChildren();
  idleHistorySection.hidden = items.length === 0;
  for (const it of items.slice(0, 12)) {
    const el = document.createElement('div');
    el.className = 'cw';
    el.innerHTML = `<div class="ph"></div><div class="t"></div><div class="s"></div>`;
    setBg(el.querySelector('.ph')!, it.thumbnail);
    el.querySelector<HTMLElement>('.t')!.textContent = it.series;
    el.querySelector<HTMLElement>('.s')!.textContent = [
      it.season ? `S${it.season}` : null,
      it.episode ? `E${it.episode}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    el.title = it.series;
    makeActivatable(el, () => void openEpisode(it.url));
    idleHistory.appendChild(el);
  }
}
$('#idle-clear').addEventListener('click', async () => {
  await clearHistory();
  await renderIdleHistory();
});

async function openEpisode(url: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.tabs.update(tab.id, { url });
}

/** Open a Crunchyroll search for a title (to find/resume a MAL/seasonal pick). */
async function openCrSearch(title: string): Promise<void> {
  await openEpisode(`https://www.crunchyroll.com/search?q=${encodeURIComponent(title)}`);
}

/** Build a portrait poster card with optional score badge / progress bar. */
function posterCard(
  picture: string | null,
  title: string,
  sub: string,
  opts: { score?: number | null; progress?: number } = {},
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'pcard';
  card.title = title;
  const ph = document.createElement('div');
  ph.className = 'ph';
  setBg(ph, picture);
  if (opts.score) {
    const b = document.createElement('div');
    b.className = 'sbadge';
    b.innerHTML = `<span style="color:#ffc24b">★</span>${opts.score.toFixed(opts.score % 1 ? 1 : 0)}`;
    ph.appendChild(b);
  }
  if (opts.progress != null && opts.progress > 0) {
    const bar = document.createElement('div');
    bar.className = 'pbar';
    const i = document.createElement('i');
    i.style.width = `${Math.min(100, opts.progress * 100)}%`;
    bar.appendChild(i);
    ph.appendChild(bar);
  }
  const t = document.createElement('div');
  t.className = 'pt';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 'ps';
  s.textContent = sub;
  card.append(ph, t, s);
  return card;
}

const SECONDS_PER_EP = 24 * 60; // avg anime episode for the "≈ N episodes" line

async function renderRun(): Promise<void> {
  const [s, hist] = await Promise.all([getStats(), getHistory()]);

  runTime.textContent = s.secondsSaved > 0 ? formatSaved(s.secondsSaved).replace('~', '') : '0m';

  const eps = Math.round(s.secondsSaved / SECONDS_PER_EP);
  runDesc.innerHTML =
    'of intros, recaps &amp; credits skipped' +
    (eps >= 1
      ? ` — that's roughly <b>${eps} full episode${eps === 1 ? '' : 's'}</b> you didn't have to sit through.`
      : '.');

  // recent-activity sparkline: a bar per day, height ∝ that day's skips
  const counts = lastNDays(s, 14);
  const max = Math.max(1, ...counts);
  runBars.replaceChildren();
  counts.forEach((count, i) => {
    const bar = document.createElement('div');
    bar.className = 'bar' + (count > 0 ? ' on' : '');
    bar.style.height = count > 0 ? `${Math.max(10, Math.round((count / max) * 38))}px` : '5px';
    const ago = counts.length - 1 - i;
    bar.title = `${count} skip${count === 1 ? '' : 's'} · ${ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago}d ago`}`;
    runBars.appendChild(bar);
  });
  runTotal.textContent = `${s.skips} skips total`;
  runSegments.textContent = String(s.skips);
  runShows.textContent = String(hist.length);
}

async function renderResume(): Promise<void> {
  const [latest] = await getHistory();
  if (!latest) {
    resumeCard.hidden = true;
    return;
  }
  resumeCard.hidden = false;
  setBg(resumeThumb, latest.thumbnail);
  resumeTitle.textContent = latest.series;
  const se = [latest.season ? `S${latest.season}` : null, latest.episode ? `E${latest.episode}` : null]
    .filter(Boolean)
    .join(' · ');
  resumeSub.textContent = [se, latest.episodeTitle].filter(Boolean).join(' — ');
  resumeCard.onclick = () => void openEpisode(latest.url);
}

let homeLoaded = false;
function loadHomeContent(): void {
  if (homeLoaded) return; // network sections load once per panel session
  homeLoaded = true;
  void loadMyList();
  void loadSeasonal();
}

async function loadMyList(): Promise<void> {
  myListSection.hidden = true;
  try {
    const r = await requestMyList('watching');
    if (!r.connected || !r.items.length) return;
    myListRail.replaceChildren();
    for (const it of r.items) {
      const card = posterCard(
        it.picture,
        it.title,
        it.total ? `${it.watched} / ${it.total}` : `Ep ${it.watched}`,
        { progress: it.total ? it.watched / it.total : 0 },
      );
      makeActivatable(card, () => void openCrSearch(it.title));
      myListRail.appendChild(card);
    }
    myListSection.hidden = false;
  } catch {
    /* leave hidden */
  }
}

async function loadSeasonal(): Promise<void> {
  seasonalSection.hidden = true;
  try {
    const r = await requestSeasonal();
    if (!r.items.length) return;
    seasonalRail.replaceChildren();
    for (const it of r.items) {
      const card = posterCard(it.picture, it.title, it.type ?? 'TV', { score: it.score });
      makeActivatable(card, () => void openCrSearch(it.title));
      seasonalRail.appendChild(card);
    }
    seasonalSection.hidden = false;
  } catch {
    /* leave hidden */
  }
}

// ── footer stats ────────────────────────────────────────────────────
async function renderStats(): Promise<void> {
  const s = await getStats();
  $('#stats').textContent =
    s.skips > 0 ? `${s.skips} skips · ${formatSaved(s.secondsSaved)} saved` : 'No skips yet';
}

// ── settings overlay ────────────────────────────────────────────────
const settingsView = $('#settingsView');
const setAutoNext = $<HTMLInputElement>('#set-autoNext');
const setKeepWatching = $<HTMLInputElement>('#set-keepWatching');
const setShowToast = $<HTMLInputElement>('#set-showToast');
const setSkip = Object.fromEntries(
  SKIP_SEGMENTS.map((k) => [k, $<HTMLInputElement>(`#set-skip-${k}`)]),
) as Record<SkipType, HTMLInputElement>;
const setMalStatusEl = $('#set-mal-status');
const setConnectBtn = $<HTMLButtonElement>('#set-connect');
const setDisconnectBtn = $<HTMLButtonElement>('#set-disconnect');
const setMalEnabled = $<HTMLInputElement>('#set-malEnabled');
const setMappingsWrap = $('#set-mappings-wrap');
const setMappingsEl = $('#set-mappings');
const modeRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="set-mode"]'));

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
  setKeepWatching.checked = s.keepWatching;
  setShowToast.checked = s.showToast;
  for (const k of SKIP_SEGMENTS) setSkip[k].checked = s.skip[k];
  for (const r of modeRadios) r.checked = r.value === s.mode;
  await renderMalSettings();
}
function openSettings(): void {
  settingsView.hidden = false;
  void renderSettings();
}
setAutoNext.addEventListener('change', () => patchSettings({ autoNext: setAutoNext.checked }));
setKeepWatching.addEventListener('change', () => patchSettings({ keepWatching: setKeepWatching.checked }));
setShowToast.addEventListener('change', () => patchSettings({ showToast: setShowToast.checked }));
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
    const redirectUri = chrome.identity.getRedirectURL();
    const verifier = randomVerifier(); // PKCE "plain": challenge == verifier
    const state = randomVerifier().slice(0, 16);
    const responseUrl = await new Promise<string | undefined>((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authorizeUrl(verifier, redirectUri, state), interactive: true },
        (url) => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message));
          else resolve(url);
        },
      );
    });
    const params = new URLSearchParams((responseUrl ?? '').split('?')[1] ?? '');
    if (params.get('state') !== state) throw new Error('State mismatch');
    const code = params.get('code');
    if (!code) throw new Error(params.get('error') ?? 'No authorization code');
    const token = await exchangeCode(code, verifier, redirectUri);
    await setTokenData(token);
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
$('#open-settings2').addEventListener('click', openSettings);
$('#set-back').addEventListener('click', () => {
  settingsView.hidden = true;
  lastMetaKey = ''; // force MAL re-fetch (connection/sync may have changed)
  homeLoaded = false; // re-pull My List/Seasonal in case MAL was just connected
  void refresh();
});

// ── recent overlay ──────────────────────────────────────────────────
const recentView = $('#recentView');
const recList = $('#rec-list');
function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}
async function renderRecent(): Promise<void> {
  const items: HistoryEntry[] = await getHistory();
  recList.replaceChildren();
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'rec-empty';
    e.textContent = 'Nothing yet — episodes you open show up here.';
    recList.appendChild(e);
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'rec-item';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'rec-open';
    open.innerHTML = `<div class="rec-thumb"></div><div class="rec-main"><div class="rec-series"></div><div class="rec-sub"></div></div><span class="rec-time"></span>`;
    setBg(open.querySelector('.rec-thumb')!, it.thumbnail);
    open.querySelector<HTMLElement>('.rec-series')!.textContent = it.series;
    const se = [it.season ? `S${it.season}` : null, it.episode ? `E${it.episode}` : null].filter(Boolean).join(' ');
    open.querySelector<HTMLElement>('.rec-sub')!.innerHTML =
      `<span class="se"></span>${it.episodeTitle ? ' · ' + it.episodeTitle : ''}`;
    open.querySelector<HTMLElement>('.se')!.textContent = se;
    open.querySelector<HTMLElement>('.rec-time')!.textContent = relTime(it.updatedAt);
    open.addEventListener('click', () => void openEpisode(it.url));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rec-del';
    del.setAttribute('aria-label', `Remove ${it.series}`);
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.addEventListener('click', async () => {
      await removeHistory(it.series);
      await renderRecent();
    });
    row.append(open, del);
    recList.appendChild(row);
  }
}
$('#open-recent').addEventListener('click', () => {
  recentView.hidden = false;
  void renderRecent();
});
$('#rec-back').addEventListener('click', () => (recentView.hidden = true));
$('#rec-clear').addEventListener('click', async () => {
  await clearHistory();
  await renderRecent();
});

// ── live updates ────────────────────────────────────────────────────
onSettingsChanged((s) => {
  settings = s;
});
let refreshTimer: number | undefined;
function scheduleRefresh(): void {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 250);
}
chrome.tabs.onActivated.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') scheduleRefresh();
});
window.setInterval(() => void refresh(), 3000);

// ── boot ────────────────────────────────────────────────────────────
void (async () => {
  settings = await getSettings().catch(() => settings);
  await renderStats();
  await refresh();
})();
