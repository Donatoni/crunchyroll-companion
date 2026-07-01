/**
 * Cloud sync engine. Mirrors four local stores to Supabase, one JSON blob per
 * kind, and merges rather than overwrites so two devices never clobber each
 * other:
 *
 *   - settings : last-write-wins (the locally-edited side wins a tie)
 *   - history  : union by series, newest episode per show, capped like local
 *   - stats    : max of each counter + per-day union (avoids double-count / loss)
 *   - mappings : union by key, pinned wins, else higher resolver version
 *
 * Runs in the service worker (it owns the alarm + storage listeners). The UI
 * triggers an immediate sync via the SYNC_NOW message after sign-in / "Sync now".
 */
import { getSettings, saveSettings, type Settings } from './settings';
import type { HistoryEntry } from './history';
import type { Stats } from './stats';
import type { TrackerMapping } from './tracker-store';
import { mergeHistory, mergeMappings, mergeStats } from './sync-merge';
import { getBlob, getSession, upsertBlob } from './supabase';

export type SyncKind = 'settings' | 'history' | 'stats' | 'mappings';
export const SYNC_KINDS: SyncKind[] = ['settings', 'history', 'stats', 'mappings'];

/** storage.local keys backing each kind (settings lives in storage.sync). */
const LOCAL_KEYS: Record<Exclude<SyncKind, 'settings'>, string> = {
  history: 'history',
  stats: 'stats',
  mappings: 'mal_mappings',
};

const META_KEY = 'sync_meta';

interface SyncMeta {
  lastSyncedAt: number;
  lastError: string;
  dirty: Partial<Record<SyncKind, boolean>>;
}

export async function getSyncMeta(): Promise<SyncMeta> {
  const r = await chrome.storage.local.get(META_KEY);
  const m = r[META_KEY] as Partial<SyncMeta> | undefined;
  return { lastSyncedAt: 0, lastError: '', dirty: {}, ...m };
}
async function setSyncMeta(patch: Partial<SyncMeta>): Promise<void> {
  const cur = await getSyncMeta();
  await chrome.storage.local.set({ [META_KEY]: { ...cur, ...patch } });
}

// ── local read/write ──────────────────────────────────────────────────
async function gatherLocal(kind: SyncKind): Promise<unknown> {
  if (kind === 'settings') return getSettings();
  const r = await chrome.storage.local.get(LOCAL_KEYS[kind]);
  return r[LOCAL_KEYS[kind]] ?? (kind === 'mappings' ? {} : kind === 'stats' ? { skips: 0, secondsSaved: 0 } : []);
}

// While applying merged data locally we suppress the storage.onChanged listener
// for THAT kind, so our own write doesn't re-mark it dirty and loop. Per-kind
// (not a global window) so a real user edit to a different kind landing during
// the apply still gets tracked.
const suppressedUntil = new Map<SyncKind, number>();
function isSuppressed(kind: SyncKind): boolean {
  return Date.now() < (suppressedUntil.get(kind) ?? 0);
}

async function applyLocal(kind: SyncKind, data: unknown): Promise<void> {
  suppressedUntil.set(kind, Date.now() + 1500);
  if (kind === 'settings') await saveSettings(data as Settings);
  else await chrome.storage.local.set({ [LOCAL_KEYS[kind]]: data });
}

/** Merge local + remote for a kind. `localChanged` breaks ties for settings. */
function merge(kind: SyncKind, local: unknown, remote: unknown, localChanged: boolean): unknown {
  switch (kind) {
    case 'settings':
      // Last-write-wins: the edited side wins; fall back to whichever exists.
      return localChanged ? local : (remote ?? local);
    case 'history':
      return mergeHistory((local as HistoryEntry[]) ?? [], (remote as HistoryEntry[]) ?? []);
    case 'stats':
      return mergeStats(
        (local as Stats) ?? DEFAULT_STATS,
        (remote as Stats) ?? DEFAULT_STATS,
      );
    case 'mappings':
      return mergeMappings(
        (local as Record<string, TrackerMapping>) ?? {},
        (remote as Record<string, TrackerMapping>) ?? {},
      );
  }
}
const DEFAULT_STATS: Stats = { skips: 0, secondsSaved: 0 };

// ── sync driver ───────────────────────────────────────────────────────
export interface SyncResult {
  ok: boolean;
  error?: string;
  lastSyncedAt: number;
}

let running: Promise<SyncResult> | null = null;

/** Pull, merge, and push every kind. Serialized so overlapping triggers coalesce. */
export function syncNow(): Promise<SyncResult> {
  if (running) return running;
  running = doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<SyncResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Not signed in', lastSyncedAt: 0 };

  const meta = await getSyncMeta();
  const dirty = { ...meta.dirty };
  try {
    for (const kind of SYNC_KINDS) {
      const local = await gatherLocal(kind);
      const remote = await getBlob(kind); // { data, updatedAt } | null
      const localChanged = !!dirty[kind];
      const merged = remote ? merge(kind, local, remote.data, localChanged) : local;

      await applyLocal(kind, merged);

      // Push when the remote is missing, we had local edits, or the merge
      // produced something different from what's stored remotely.
      const changedVsRemote =
        !remote || localChanged || JSON.stringify(merged) !== JSON.stringify(remote.data);
      if (changedVsRemote) await upsertBlob(kind, merged);
      dirty[kind] = false;
    }
    const lastSyncedAt = Date.now();
    await setSyncMeta({ lastSyncedAt, lastError: '', dirty });
    return { ok: true, lastSyncedAt };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'sync failed';
    await setSyncMeta({ lastError: error, dirty });
    return { ok: false, error, lastSyncedAt: meta.lastSyncedAt };
  }
}

// ── change tracking ───────────────────────────────────────────────────
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Handle a storage change: mark the affected kind dirty and schedule a debounced
 * sync. Ignores our own merge-writes (suppressed) and no-ops when signed out.
 */
export function handleStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): void {
  const candidates: SyncKind[] = [];
  if (area === 'sync' && 'settings' in changes) candidates.push('settings');
  if (area === 'local') {
    if ('history' in changes) candidates.push('history');
    if ('stats' in changes) candidates.push('stats');
    if ('mal_mappings' in changes) candidates.push('mappings');
  }
  const touched = candidates.filter((k) => !isSuppressed(k));
  if (!touched.length) return;

  void (async () => {
    if (!(await getSession())) return; // signed out — nothing to sync
    const meta = await getSyncMeta();
    const dirty = { ...meta.dirty };
    for (const k of touched) dirty[k] = true;
    await setSyncMeta({ dirty });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void syncNow(), 4000);
  })();
}
