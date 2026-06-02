/**
 * Lifetime skip stats, shown in the popup footer. Stored in storage.local
 * (device-local). secondsSaved is only known for seek-mode skips (we have the
 * segment length); native-button clicks bump the count without a duration.
 */
import { isExtensionContextValid } from './runtime';

const KEY = 'stats';

export interface Stats {
  skips: number;
  secondsSaved: number;
}

export async function getStats(): Promise<Stats> {
  const r = await chrome.storage.local.get(KEY);
  return (r[KEY] as Stats | undefined) ?? { skips: 0, secondsSaved: 0 };
}

export async function bumpSkip(seconds = 0): Promise<void> {
  if (!isExtensionContextValid()) return; // orphaned content script
  try {
    const s = await getStats();
    s.skips += 1;
    s.secondsSaved += Math.max(0, Math.round(seconds));
    await chrome.storage.local.set({ [KEY]: s });
  } catch {
    /* extension context invalidated — ignore */
  }
}

/** Format seconds as "~3h 10m" / "~12m" / "~0m". */
export function formatSaved(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `~${m}m`;
  return `~${Math.floor(m / 60)}h ${m % 60}m`;
}
