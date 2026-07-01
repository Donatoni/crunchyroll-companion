import { describe, expect, it } from 'vitest';
import { detectSeason, matchScore, normalizeTitle, titleSimilarity } from '@/shared/mal-match';

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeTitle('Re:ZERO -Starting Life in Another World-')).toBe(
      're zero starting life in another world',
    );
  });
  it('reduces fully non-latin titles to empty', () => {
    expect(normalizeTitle('ようこそ実力至上主義の教室へ')).toBe('');
  });
});

describe('detectSeason', () => {
  it('reads explicit season markers', () => {
    expect(detectSeason('fire force season 2', 'Fire Force')).toBe(2);
    expect(detectSeason('mob psycho 100 2nd season', 'Mob Psycho 100')).toBe(2);
  });
  it('reads roman numerals and final season', () => {
    expect(detectSeason('overlord iv', 'Overlord')).toBe(4);
    expect(detectSeason('overlord iii', 'Overlord')).toBe(3);
    expect(detectSeason('attack on titan final season', 'Attack on Titan')).toBe(99);
  });
  it('treats a trailing small number as a season', () => {
    expect(detectSeason('my hero academia 3', 'My Hero Academia')).toBe(3);
  });
  it("doesn't mistake a number that's part of the base name", () => {
    expect(detectSeason('mob psycho 100', 'Mob Psycho 100')).toBe(1);
  });
  it('defaults to season 1', () => {
    expect(detectSeason('black clover', 'Black Clover')).toBe(1);
  });
});

describe('titleSimilarity', () => {
  it('ranks exact > prefix > substring > word overlap', () => {
    const q = 'black clover';
    const exact = titleSimilarity(q, 'black clover');
    const prefix = titleSimilarity(q, 'black clover sword of the wizard king');
    const substr = titleSimilarity(q, 'mugyutto black clover');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substr);
  });
});

describe('matchScore', () => {
  const tv = (title: string, altTitles: string[] = []) => ({
    title,
    altTitles,
    mediaType: 'tv',
  });

  it('prefers the real series over a spin-off that contains the name', () => {
    const main = matchScore('Black Clover', 1, tv('Black Clover'));
    const chibi = matchScore('Black Clover', 1, {
      title: 'Mugyutto! Black Clover',
      altTitles: [],
      mediaType: 'special',
    });
    expect(main).toBeGreaterThan(chibi);
  });

  it('prefers the season-2 entry when watching season 2', () => {
    const s1 = matchScore('Fire Force', 2, tv('Enen no Shouboutai', ['Fire Force']));
    const s2 = matchScore(
      'Fire Force',
      2,
      tv('Enen no Shouboutai: Ni no Shou', ['Fire Force Season 2']),
    );
    expect(s2).toBeGreaterThan(s1);
  });

  it('scores zero for an empty query', () => {
    expect(matchScore('', 1, tv('Anything'))).toBe(0);
  });
});
