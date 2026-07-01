/**
 * DOM fallback: auto-click Crunchyroll's native skip button when it appears.
 *
 * Used when skip-events data is unavailable for an episode, or when the user
 * forces 'click' mode. Selectors are intentionally broad — Crunchyroll changes
 * markup often — matching by data-testid, aria-label, and visible text, and
 * descending into shadow roots where the player overlay sometimes lives.
 */
import { log } from '@/shared/log';
import { bumpSkip } from '@/shared/stats';

const SKIP_TEXT = /\bskip\b/i;

/** data-testid values Crunchyroll has used for the skip CTA. */
const TESTID_SELECTOR =
  '[data-testid="skipIntroText"], [data-testid="overlay-cta"], [data-testid*="skip" i]';

function matchesSkip(el: Element): boolean {
  const aria = el.getAttribute('aria-label') ?? '';
  const title = el.getAttribute('title') ?? '';
  const text = (el.textContent ?? '').trim();
  return SKIP_TEXT.test(aria) || SKIP_TEXT.test(title) || SKIP_TEXT.test(text);
}

/**
 * Find the first VISIBLE clickable skip element under a root, checking the
 * cheapest sources first and only falling back to the expensive full-document
 * walk (every element, recursing shadow roots) when nothing lighter matched.
 * Early-exiting here matters: this runs on a 150ms-coalesced MutationObserver
 * against a player that mutates constantly.
 */
function findSkipButton(root: ParentNode): HTMLElement | null {
  const clickable = (el: HTMLElement): boolean =>
    typeof el.click === 'function' && isVisible(el);

  for (const el of root.querySelectorAll<HTMLElement>(TESTID_SELECTOR)) {
    if (clickable(el)) return el;
  }
  for (const el of root.querySelectorAll<HTMLElement>('button, [role="button"], a')) {
    if (matchesSkip(el) && clickable(el)) return el;
  }
  // Last resort: recurse into open shadow roots.
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.shadowRoot) {
      const found = findSkipButton(el.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

export interface DomSkipController {
  stop: () => void;
}

/**
 * Watch the DOM and click any visible skip button. `enabled()` is consulted on
 * every potential click so the user's master toggle is always respected.
 */
export function startDomSkip(enabled: () => boolean): DomSkipController {
  const tryClick = () => {
    if (!enabled()) return;
    const btn = findSkipButton(document);
    if (!btn) return;
    log('clicking native skip button:', (btn.textContent ?? '').trim().slice(0, 30));
    btn.click();
    void bumpSkip(0);
  };

  // The player mutates attributes (progress bar, time, ARIA) many times per
  // second; tryClick walks the whole document (incl. shadow roots), so running
  // it on every mutation is expensive. Coalesce bursts behind a short timer.
  // NOTE: a timer, not requestAnimationFrame — rAF callbacks are paused while
  // the tab is in the background, which would stop click-mode auto-skip the
  // moment you switch to another tab. setTimeout keeps firing (a playing tab is
  // audible and so exempt from heavy background throttling).
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      tryClick();
    }, 150);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-label', 'data-testid'],
  });

  // Initial sweep in case the button is already present.
  tryClick();

  return { stop: () => observer.disconnect() };
}
