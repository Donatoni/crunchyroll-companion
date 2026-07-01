import { describe, expect, it } from 'vitest';
import { parseSkipEvents, skipEventsUrl } from '@/shared/skip-events';

describe('skipEventsUrl', () => {
  it('builds the static URL and escapes the id', () => {
    expect(skipEventsUrl('GRDKJZ81Y')).toBe(
      'https://static.crunchyroll.com/skip-events/production/GRDKJZ81Y.json',
    );
    expect(skipEventsUrl('a/b')).toContain('a%2Fb');
  });
});

describe('parseSkipEvents', () => {
  it('parses well-formed segments and sorts by start', () => {
    const raw = {
      credits: { start: 1300, end: 1390 },
      intro: { start: 10, end: 99, type: 'intro', extra: 'ignored' },
    };
    expect(parseSkipEvents(raw)).toEqual([
      { type: 'intro', start: 10, end: 99 },
      { type: 'credits', start: 1300, end: 1390 },
    ]);
  });

  it('ignores unknown keys and malformed entries', () => {
    expect(
      parseSkipEvents({
        banana: { start: 1, end: 2 },
        intro: { start: 'x', end: 99 },
        recap: { start: 5 },
        preview: null,
      }),
    ).toEqual([]);
  });

  it('rejects zero-length and inverted windows', () => {
    expect(parseSkipEvents({ intro: { start: 50, end: 50 } })).toEqual([]);
    expect(parseSkipEvents({ intro: { start: 90, end: 10 } })).toEqual([]);
  });

  it('rejects non-finite numbers', () => {
    expect(parseSkipEvents({ intro: { start: 0, end: Infinity } })).toEqual([]);
    expect(parseSkipEvents({ intro: { start: NaN, end: 90 } })).toEqual([]);
  });

  it('handles non-object input', () => {
    expect(parseSkipEvents(null)).toEqual([]);
    expect(parseSkipEvents('nope')).toEqual([]);
    expect(parseSkipEvents(42)).toEqual([]);
  });
});
