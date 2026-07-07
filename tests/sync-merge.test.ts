import { describe, expect, it } from 'vitest';
import { mergeHistory, mergeMappings, mergeStats } from '@/shared/sync-merge';
import type { HistoryEntry } from '@/shared/history';

const entry = (series: string, updatedAt: number, episode = 1): HistoryEntry => ({
  episodeId: `${series}-${episode}`,
  url: `https://www.crunchyroll.com/watch/${series}`,
  series,
  episodeTitle: '',
  episode,
  season: 1,
  thumbnail: '',
  updatedAt,
});

describe('mergeHistory', () => {
  it('unions by series, keeping the newer entry per show', () => {
    const local = [entry('Frieren', 200, 5)];
    const remote = [entry('Frieren', 100, 4), entry('Dandadan', 150, 2)];
    const merged = mergeHistory(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged[0].series).toBe('Frieren'); // newest first
    expect(merged[0].episode).toBe(5);
  });

  it('dedupes case-insensitively and drops entries without a series', () => {
    const merged = mergeHistory(
      [entry('frieren', 2)],
      [entry('FRIEREN', 1), { ...entry('x', 3), series: '' }],
    );
    expect(merged).toHaveLength(1);
  });

  it('caps at 30 like local history', () => {
    const local = Array.from({ length: 40 }, (_, i) => entry(`show-${i}`, i));
    expect(mergeHistory(local, [])).toHaveLength(30);
  });

  it('a bookmark set on either device survives a newer unflagged entry', () => {
    // Laptop bookmarked at E4; desktop later watched E7 without the flag.
    const laptop = [{ ...entry('Frieren', 100, 4), bookmarked: true }];
    const desktop = [entry('Frieren', 200, 7)];
    const [a] = mergeHistory(laptop, desktop);
    expect(a.episode).toBe(7); // newer entry wins the data…
    expect(a.bookmarked).toBe(true); // …but the bookmark survives
    const [b] = mergeHistory(desktop, laptop); // and in the other direction
    expect(b.bookmarked).toBe(true);
  });

  it('never evicts bookmarked entries at the cap', () => {
    // The bookmarked show is the OLDEST of 40 — naive slice(0,30) drops it.
    const local = [
      { ...entry('keeper', 0, 3), bookmarked: true },
      ...Array.from({ length: 40 }, (_, i) => entry(`show-${i}`, i + 1)),
    ];
    const merged = mergeHistory(local, []);
    expect(merged.filter((e) => !e.bookmarked)).toHaveLength(30);
    expect(merged.some((e) => e.series === 'keeper')).toBe(true);
  });
});

describe('mergeStats', () => {
  it('takes the max of counters and unions days', () => {
    const merged = mergeStats(
      { skips: 10, secondsSaved: 900, days: { '2026-06-30': 3 } },
      { skips: 8, secondsSaved: 1200, days: { '2026-06-30': 5, '2026-06-29': 2 } },
    );
    expect(merged).toEqual({
      skips: 10,
      secondsSaved: 1200,
      days: { '2026-06-30': 5, '2026-06-29': 2 },
    });
  });

  it('tolerates missing fields', () => {
    const merged = mergeStats(
      { skips: 0, secondsSaved: 0 },
      { skips: 1, secondsSaved: 60 },
    );
    expect(merged.skips).toBe(1);
    expect(merged.days).toEqual({});
  });
});

describe('mergeMappings', () => {
  const m = (mediaId: number, opts: { pinned?: boolean; v?: number } = {}) => ({
    mediaId,
    title: `t${mediaId}`,
    episodes: 12,
    ...opts,
  });

  it('unions disjoint keys', () => {
    const merged = mergeMappings({ a: m(1) }, { b: m(2) });
    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });

  it('a pinned side always wins', () => {
    expect(mergeMappings({ a: m(1, { pinned: true }) }, { a: m(2, { v: 9 }) }).a.mediaId).toBe(1);
    expect(mergeMappings({ a: m(1, { v: 9 }) }, { a: m(2, { pinned: true }) }).a.mediaId).toBe(2);
  });

  it('otherwise the newer resolver version wins (local ties win)', () => {
    expect(mergeMappings({ a: m(1, { v: 2 }) }, { a: m(2, { v: 1 }) }).a.mediaId).toBe(1);
    expect(mergeMappings({ a: m(1, { v: 1 }) }, { a: m(2, { v: 2 }) }).a.mediaId).toBe(2);
    expect(mergeMappings({ a: m(1, { v: 2 }) }, { a: m(2, { v: 2 }) }).a.mediaId).toBe(1);
  });
});
