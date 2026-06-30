import { log } from '@/shared/log';

/**
 * Keep long auto-play sessions going by dismissing Crunchyroll's interruptions:
 *  - the "are you still watching?" idle/continuous-play gate, and
 *  - the profile picker that can reappear mid-session.
 *
 * Best-effort and deliberately narrow: it only ever clicks an affirmative
 * "keep watching"-style button, or — when a profile-picker heading is on screen
 * — the first profile tile. It never touches password fields or types anything.
 * Crunchyroll's markup is undocumented, so the matchers are broad-by-text and
 * may need tuning; everything is logged under "[Crunchyroll Companion]".
 */

// Specific phrases unlikely to appear on a normal watch page (avoids clicking
// random "Continue"/"Yes" buttons).
const RESUME =
  /(keep watching|continue watching|still watching|are you still|i'?m still (?:here|watching)|yes,?\s*i'?m\s*(?:still\s*)?watching|resume playback)/i;

const PROFILE_HEADING = /who(?:'s| is)? watching|(?:select|choose|pick)\s+(?:a\s+)?profile/i;

function isVisible(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

function labelOf(el: Element): string {
  return `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim();
}

/** Click an affirmative "keep watching" button if one is visible. */
function dismissStillWatching(): boolean {
  for (const el of document.querySelectorAll('button, [role="button"], a')) {
    if (isVisible(el) && RESUME.test(labelOf(el))) {
      log('keep-watching: dismissing prompt →', labelOf(el).slice(0, 40));
      el.click();
      return true;
    }
  }
  return false;
}

/** If the profile picker is showing, click the first profile tile to resume. */
function dismissProfilePicker(): boolean {
  const headingShown = Array.from(
    document.querySelectorAll('h1, h2, h3, [role="heading"]'),
  ).some((h) => PROFILE_HEADING.test(h.textContent ?? ''));
  if (!headingShown) return false;

  const tiles = document.querySelectorAll(
    '[data-testid*="profile" i], [aria-label*="profile" i], a[href*="profile" i], [class*="profile" i] button',
  );
  for (const el of tiles) {
    if (isVisible(el)) {
      log('keep-watching: selecting profile to resume playback');
      el.click();
      return true;
    }
  }
  log('keep-watching: profile picker detected but no tile matched (needs tuning)');
  return false;
}

export interface KeepWatchingController {
  stop: () => void;
}

export function startKeepWatching(enabled: () => boolean): KeepWatchingController {
  const tick = () => {
    if (!enabled()) return;
    if (dismissStillWatching()) return;
    dismissProfilePicker();
  };

  // Coalesce mutation bursts so a noisy DOM doesn't run tick() (a full-document
  // scan) hundreds of times a second.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      tick();
    }, 250);
  };

  // These prompts don't always arrive via observable mutations, so poll too.
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const interval = window.setInterval(tick, 2000);
  tick();

  return {
    stop: () => {
      observer.disconnect();
      window.clearInterval(interval);
    },
  };
}
