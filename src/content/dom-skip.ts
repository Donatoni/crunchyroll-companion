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

/** Collect candidate clickable skip elements from a root (incl. shadow roots). */
function findSkipButtons(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = [];

  for (const el of root.querySelectorAll<HTMLElement>(TESTID_SELECTOR)) {
    out.push(el);
  }
  for (const el of root.querySelectorAll<HTMLElement>(
    'button, [role="button"], a',
  )) {
    if (matchesSkip(el)) out.push(el);
  }
  // Recurse into open shadow roots.
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.shadowRoot) out.push(...findSkipButtons(el.shadowRoot));
  }

  return out;
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
    for (const btn of findSkipButtons(document)) {
      // Some matches (e.g. SVG icons) aren't clickable HTMLElements — skip them
      // and keep looking rather than throwing.
      if (typeof btn.click !== 'function' || !isVisible(btn)) continue;
      log('clicking native skip button:', (btn.textContent ?? '').trim().slice(0, 30));
      btn.click();
      void bumpSkip(0);
      break;
    }
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
