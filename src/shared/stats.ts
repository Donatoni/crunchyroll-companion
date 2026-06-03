/**
 * Lifetime skip stats, shown in the popup footer. Stored in storage.local
 * (device-local). secondsSaved is only known for seek-mode skips (we have the
 * segment length); native-button clicks bump the count without a duration.
 */
import { isExtensionContextValid } from './runtime';

const KEY = 'stats';
const DAY_MS = 86_400_000;

export interface Stats {
  skips: number;
  secondsSaved: number;
  /** Per-day skip counts keyed by YYYY-MM-DD (for the activity strip). */
  days?: Record<string, number>;
}

function dayKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
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
    const days = s.days ?? {};
    const today = dayKey();
    days[today] = (days[today] ?? 0) + 1;
    // keep ~3 weeks of history
    const cutoff = dayKey(Date.now() - 21 * DAY_MS);
    for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
    s.days = days;
    await chrome.storage.local.set({ [KEY]: s });
  } catch {
    /* extension context invalidated — ignore */
  }
}

/** Skip counts for the last `n` days, oldest → newest (for the activity strip). */
export function lastNDays(stats: Stats, n: number): number[] {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(stats.days?.[dayKey(Date.now() - i * DAY_MS)] ?? 0);
  return out;
}

/** Format seconds as "~3h 10m" / "~12m" / "~0m". */
export function formatSaved(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `~${m}m`;
  return `~${Math.floor(m / 60)}h ${m % 60}m`;
}
