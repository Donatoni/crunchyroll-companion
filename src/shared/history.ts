/**
 * Local "continue watching" history. Each opened episode is recorded (one entry
 * per series — the latest episode you were on), newest first, in storage.local.
 */
import { isExtensionContextValid } from './runtime';

const KEY = 'history';
const MAX = 30;

export interface HistoryEntry {
  episodeId: string;
  url: string;
  series: string;
  episodeTitle: string;
  episode: number | null;
  season: number | null;
  thumbnail: string;
  /** Epoch ms when last opened. */
  updatedAt: number;
  /**
   * SHOW-level bookmark ("I mean to come back and finish this"). Lives on the
   * history entry so the resume point is self-maintaining: the entry upserts to
   * the latest episode every time you watch. Bookmarked entries are exempt from
   * the size cap and survive "Clear".
   */
  bookmarked?: boolean;
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const r = await chrome.storage.local.get(KEY);
  const list = (r[KEY] as HistoryEntry[] | undefined) ?? [];
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Cap the list at MAX non-bookmarked entries; bookmarks are never evicted. */
function capped(list: HistoryEntry[]): HistoryEntry[] {
  const next: HistoryEntry[] = [];
  let plain = 0;
  for (const e of list) {
    if (e.bookmarked) next.push(e);
    else if (plain < MAX) {
      next.push(e);
      plain++;
    }
  }
  return next;
}

/** Upsert an entry, keyed by series, moving it to the front. */
export async function recordHistory(
  entry: Omit<HistoryEntry, 'updatedAt' | 'bookmarked'>,
): Promise<void> {
  if (!entry.series) return;
  if (!isExtensionContextValid()) return; // orphaned content script
  try {
    const r = await chrome.storage.local.get(KEY);
    const list = (r[KEY] as HistoryEntry[] | undefined) ?? [];
    const key = entry.series.trim().toLowerCase();
    const existing = list.find((e) => e.series.trim().toLowerCase() === key);
    const next = capped([
      // Carry the bookmark across the upsert — watching must never unbookmark.
      { ...entry, updatedAt: Date.now(), bookmarked: existing?.bookmarked },
      ...list.filter((e) => e.series.trim().toLowerCase() !== key),
    ]);
    await chrome.storage.local.set({ [KEY]: next });
  } catch {
    /* extension context invalidated — ignore */
  }
}

/**
 * Set/clear the show-level bookmark on a series' history entry. Returns false
 * when the series has no entry yet (nothing to hang the bookmark on).
 */
export async function setBookmark(series: string, bookmarked: boolean): Promise<boolean> {
  const key = series.trim().toLowerCase();
  const r = await chrome.storage.local.get(KEY);
  const list = (r[KEY] as HistoryEntry[] | undefined) ?? [];
  const entry = list.find((e) => e.series.trim().toLowerCase() === key);
  if (!entry) return false;
  entry.bookmarked = bookmarked || undefined; // drop the field when cleared
  await chrome.storage.local.set({ [KEY]: list });
  return true;
}

/** The bookmarked shows, newest-watched first. */
export async function getBookmarks(): Promise<HistoryEntry[]> {
  return (await getHistory()).filter((e) => e.bookmarked);
}

/** Whether a series is bookmarked. */
export async function isBookmarked(series: string): Promise<boolean> {
  const key = series.trim().toLowerCase();
  const list = await getHistory();
  return !!list.find((e) => e.series.trim().toLowerCase() === key)?.bookmarked;
}

/** Remove a single entry by series (the key each entry is stored under). */
export async function removeHistory(series: string): Promise<void> {
  const r = await chrome.storage.local.get(KEY);
  const list = (r[KEY] as HistoryEntry[] | undefined) ?? [];
  const key = series.trim().toLowerCase();
  await chrome.storage.local.set({
    [KEY]: list.filter((e) => e.series.trim().toLowerCase() !== key),
  });
}

/** Clear the history — except bookmarked shows, which the user asked to keep. */
export async function clearHistory(): Promise<void> {
  const r = await chrome.storage.local.get(KEY);
  const list = (r[KEY] as HistoryEntry[] | undefined) ?? [];
  const keep = list.filter((e) => e.bookmarked);
  if (keep.length) await chrome.storage.local.set({ [KEY]: keep });
  else await chrome.storage.local.remove(KEY);
}
