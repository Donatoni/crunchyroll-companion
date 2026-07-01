import { describe, expect, it } from 'vitest';
import { formatSaved, lastNDays, type Stats } from '@/shared/stats';

describe('formatSaved', () => {
  it('formats minutes under an hour', () => {
    expect(formatSaved(0)).toBe('~0m');
    expect(formatSaved(12 * 60)).toBe('~12m');
  });
  it('formats hours + minutes', () => {
    expect(formatSaved(3 * 3600 + 10 * 60)).toBe('~3h 10m');
  });
  it('rounds to the nearest minute', () => {
    expect(formatSaved(89)).toBe('~1m');
  });
});

describe('lastNDays', () => {
  it('returns n entries oldest → newest with zeros for missing days', () => {
    const stats: Stats = { skips: 3, secondsSaved: 100, days: {} };
    const out = lastNDays(stats, 5);
    expect(out).toHaveLength(5);
    expect(out.every((v) => v === 0)).toBe(true);
  });
  it("picks up today's local-keyed count in the last slot", () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const stats: Stats = { skips: 4, secondsSaved: 0, days: { [today]: 4 } };
    expect(lastNDays(stats, 3).at(-1)).toBe(4);
  });
});
