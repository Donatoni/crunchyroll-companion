/**
 * Pure merge strategies for cloud sync, one per kind. Extracted from sync.ts so
 * they can be unit tested — a bad merge silently corrupts user data on BOTH
 * devices, so this is the logic most worth pinning down.
 *
 *   - history  : union by series, newest episode per show, capped like local
 *   - stats    : max of each counter + per-day union (avoids double-count / loss)
 *   - mappings : union by key, pinned wins, else higher resolver version
 */
import type { HistoryEntry } from './history';
import type { Stats } from './stats';
import type { TrackerMapping } from './tracker-store';

export function mergeHistory(local: HistoryEntry[], remote: HistoryEntry[]): HistoryEntry[] {
  const byKey = new Map<string, HistoryEntry>();
  for (const e of [...remote, ...local]) {
    if (!e?.series) continue;
    const k = e.series.trim().toLowerCase();
    const cur = byKey.get(k);
    const newer = !cur || e.updatedAt > cur.updatedAt ? e : cur;
    // The bookmark survives if EITHER side has it — otherwise a newer unflagged
    // entry from one device silently wipes a bookmark set on another.
    const bookmarked = !!(cur?.bookmarked || e.bookmarked) || undefined;
    byKey.set(k, bookmarked ? { ...newer, bookmarked: true } : newer);
  }
  const sorted = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  // Cap like local history: 30 non-bookmarked entries; bookmarks never evicted.
  const out: HistoryEntry[] = [];
  let plain = 0;
  for (const e of sorted) {
    if (e.bookmarked) out.push(e);
    else if (plain < 30) {
      out.push(e);
      plain++;
    }
  }
  return out;
}

export function mergeStats(local: Stats, remote: Stats): Stats {
  const days: Record<string, number> = {};
  for (const src of [remote.days, local.days]) {
    for (const [k, v] of Object.entries(src ?? {})) days[k] = Math.max(days[k] ?? 0, v);
  }
  return {
    skips: Math.max(local.skips ?? 0, remote.skips ?? 0),
    secondsSaved: Math.max(local.secondsSaved ?? 0, remote.secondsSaved ?? 0),
    days,
  };
}

export function mergeMappings(
  local: Record<string, TrackerMapping>,
  remote: Record<string, TrackerMapping>,
): Record<string, TrackerMapping> {
  const out: Record<string, TrackerMapping> = { ...remote };
  for (const [k, lv] of Object.entries(local)) {
    const rv = out[k];
    if (!rv) out[k] = lv;
    else if (lv.pinned && !rv.pinned) out[k] = lv;
    else if (!lv.pinned && rv.pinned) { /* keep remote (pinned) */ }
    else out[k] = (lv.v ?? 0) >= (rv.v ?? 0) ? lv : rv; // prefer newer resolver
  }
  return out;
}
