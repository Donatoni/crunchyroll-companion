/** Small DOM + navigation helpers shared by the side panel's view modules. */

export const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Escape a value for safe interpolation into an innerHTML string. */
export const esc = (v: unknown): string =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string),
  );

export function setBg(el: HTMLElement, url: string | null | undefined): void {
  if (!url) {
    el.style.backgroundImage = '';
    return;
  }
  // Strip characters that could break out of the CSS string / url() wrapper.
  const safe = url.replace(/["\\\n\r()]/g, '');
  el.style.backgroundImage = `url("${safe}")`;
}

/** Make a non-button element (a card <div>) keyboard-activatable. */
export function makeActivatable(el: HTMLElement, onActivate: () => void): void {
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

/**
 * Make a horizontal rail navigable with a mouse: vertical wheel scrolls it
 * sideways, and click-drag pans it (a trackpad can already swipe horizontally,
 * and the scrollbar is hidden). A drag past a small threshold swallows the
 * trailing click so dragging across a card doesn't also activate it.
 */
export function makeRailScrollable(rail: HTMLElement): void {
  const overflowing = () => rail.scrollWidth > rail.clientWidth + 1;

  rail.addEventListener(
    'wheel',
    (e) => {
      // Only hijack a mostly-vertical wheel, and only when there's room to pan.
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || !overflowing()) return;
      rail.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );

  const DRAG_THRESHOLD = 5; // px before a press becomes a pan (vs. a click)
  let down = false;
  let dragged = false;
  let startX = 0;
  let startScroll = 0;

  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !overflowing()) return;
    down = true;
    dragged = false;
    startX = e.clientX;
    startScroll = rail.scrollLeft;
  });
  rail.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (!dragged && Math.abs(dx) > DRAG_THRESHOLD) {
      dragged = true;
      rail.setPointerCapture(e.pointerId);
      rail.classList.add('dragging');
    }
    if (dragged) {
      rail.scrollLeft = startScroll - dx;
      e.preventDefault();
    }
  });
  const endDrag = (e: PointerEvent) => {
    if (!down) return;
    down = false;
    if (rail.hasPointerCapture(e.pointerId)) rail.releasePointerCapture(e.pointerId);
    rail.classList.remove('dragging');
  };
  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', endDrag);
  // Capture phase so this runs before a card's own click handler and can cancel it.
  rail.addEventListener(
    'click',
    (e) => {
      if (dragged) {
        e.stopPropagation();
        e.preventDefault();
        dragged = false;
      }
    },
    true,
  );
}

/** "3m ago" / "2h ago" / "5d ago" / "3w ago" for history timestamps. */
export function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}

/** Open a URL in a NEW tab (for discovery — don't hijack the user's current tab). */
export async function openInNewTab(url: string): Promise<void> {
  await chrome.tabs.create({ url });
}

/** Open a previously-watched episode in a NEW tab so the user's current page is preserved. */
export async function openEpisode(url: string): Promise<void> {
  await openInNewTab(url);
}

/** Open a Crunchyroll search for a title (to find/resume a MAL/seasonal pick). */
export async function openCrSearch(title: string): Promise<void> {
  await openInNewTab(`https://www.crunchyroll.com/search?q=${encodeURIComponent(title)}`);
}

/** Build a portrait poster card with optional score badge / progress bar. */
export function posterCard(
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
    b.innerHTML = `<span style="color:#ffc24b">★</span>${esc(
      opts.score.toFixed(opts.score % 1 ? 1 : 0),
    )}`;
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

/** Fill a rail with shimmering placeholder cards while its data loads. */
export function railSkeleton(rail: HTMLElement, count = 6): void {
  rail.replaceChildren();
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'pcard skel';
    el.innerHTML = '<div class="ph"></div><div class="pt"></div><div class="ps"></div>';
    rail.appendChild(el);
  }
}
