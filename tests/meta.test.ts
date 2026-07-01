import { describe, expect, it } from 'vitest';
import { parseEpSeason, titleCase } from '@/content/meta';

describe('parseEpSeason', () => {
  it('reads og:title style "Season 1 Part 1 | E2 – The Boys\' Promise"', () => {
    expect(parseEpSeason("Season 1 Part 1 | E2 – The Boys' Promise")).toEqual({
      episode: 2,
      season: 1,
    });
  });
  it('reads long-form "Episode 12"', () => {
    expect(parseEpSeason('Episode 12 — The Final Battle')).toEqual({
      episode: 12,
      season: null,
    });
  });
  it('reads compact "S3 E4"', () => {
    expect(parseEpSeason('S3 E4')).toEqual({ episode: 4, season: 3 });
  });
  it('returns nulls when nothing matches', () => {
    expect(parseEpSeason('Just a Movie Title')).toEqual({ episode: null, season: null });
  });
});

describe('titleCase', () => {
  it('capitalizes slug words', () => {
    expect(titleCase('the-flying-classroom')).toBe('The Flying Classroom');
  });
  it('keeps small words lowercase except at the start', () => {
    expect(titleCase('a-tale-of-two-cities')).toBe('A Tale of Two Cities');
  });
  it('ignores empty segments', () => {
    expect(titleCase('hello--world')).toBe('Hello World');
  });
});
