import { describe, it, expect } from 'vitest';
import { ndcgAtK, recallAtK, reciprocalRank } from './metrics.js';

const rel = (...ids: string[]): ReadonlySet<string> => new Set(ids);

// Hand-computed. log2(2) = 1, log2(3) = 1.584963, log2(4) = 2, log2(5) = 2.321928.
const d = (position: number): number => 1 / Math.log2(position + 2);

describe('recallAtK', () => {
  it('counts relevant ids inside the cut and divides by the relevant set', () => {
    const ranked = ['a', 'x', 'b', 'y', 'c'];
    expect(recallAtK(ranked, rel('a', 'b', 'c'), 1)).toBeCloseTo(1 / 3, 12);
    expect(recallAtK(ranked, rel('a', 'b', 'c'), 3)).toBeCloseTo(2 / 3, 12);
    expect(recallAtK(ranked, rel('a', 'b', 'c'), 5)).toBe(1);
    expect(recallAtK(ranked, rel('a', 'b', 'c'), 10)).toBe(1);
  });

  it('scores an empty list 0', () => {
    expect(recallAtK([], rel('a'), 10)).toBe(0);
  });

  it('scores 0 rather than NaN when nothing is relevant', () => {
    expect(recallAtK(['a', 'b'], rel(), 10)).toBe(0);
  });

  it('counts a repeated id once', () => {
    expect(recallAtK(['a', 'a', 'a'], rel('a', 'b'), 3)).toBe(0.5);
    // The repeat does not use up a position either.
    expect(recallAtK(['a', 'a', 'b'], rel('a', 'b'), 2)).toBe(1);
  });

  it('depends on how tied candidates were ordered, which is why ties get a range', () => {
    // Two candidates a retriever scored identically, broken two ways.
    expect(recallAtK(['x', 'a'], rel('a'), 1)).toBe(0);
    expect(recallAtK(['a', 'x'], rel('a'), 1)).toBe(1);
  });
});

describe('reciprocalRank', () => {
  it('is 1 / the 1-indexed position of the first relevant id', () => {
    expect(reciprocalRank(['a', 'b'], rel('a'))).toBe(1);
    expect(reciprocalRank(['x', 'y', 'a', 'b'], rel('a', 'b'))).toBeCloseTo(1 / 3, 12);
  });

  it('is 0 for an empty list and for a list with nothing relevant', () => {
    expect(reciprocalRank([], rel('a'))).toBe(0);
    expect(reciprocalRank(['x', 'y'], rel('a'))).toBe(0);
    expect(reciprocalRank(['x', 'y'], rel())).toBe(0);
  });

  it('ignores a repeat when counting positions', () => {
    expect(reciprocalRank(['x', 'x', 'a'], rel('a'))).toBe(0.5);
  });

  it('moves with the order of tied candidates', () => {
    expect(reciprocalRank(['x', 'a'], rel('a'))).toBe(0.5);
    expect(reciprocalRank(['a', 'x'], rel('a'))).toBe(1);
  });
});

describe('ndcgAtK', () => {
  it('is 1 for an ideal ranking', () => {
    expect(ndcgAtK(['a', 'b', 'x'], rel('a', 'b'), 3)).toBe(1);
    expect(ndcgAtK(['b', 'a'], rel('a', 'b'), 10)).toBe(1);
  });

  it('matches a hand-computed binary DCG over IDCG', () => {
    // Relevant at positions 1 and 3 (0-indexed), two relevant, k = 5.
    const ranked = ['x', 'a', 'y', 'b', 'z'];
    const expected = (d(1) + d(3)) / (d(0) + d(1));
    expect(ndcgAtK(ranked, rel('a', 'b'), 5)).toBeCloseTo(expected, 12);
    // 0.6309 + 0.4307 over 1 + 0.6309.
    expect(ndcgAtK(ranked, rel('a', 'b'), 5)).toBeCloseTo(0.650921, 6);
  });

  it('caps the ideal at k when more ids are relevant than fit', () => {
    // Three relevant, k = 2: the ideal is two hits at positions 0 and 1.
    expect(ndcgAtK(['a', 'x'], rel('a', 'b', 'c'), 2)).toBeCloseTo(d(0) / (d(0) + d(1)), 12);
  });

  it('scores an empty list and an empty relevant set 0', () => {
    expect(ndcgAtK([], rel('a'), 10)).toBe(0);
    expect(ndcgAtK(['a'], rel(), 10)).toBe(0);
  });

  it('ignores everything past k', () => {
    expect(ndcgAtK(['x', 'y', 'a'], rel('a'), 2)).toBe(0);
  });

  it('moves with the order of tied candidates', () => {
    expect(ndcgAtK(['a', 'x'], rel('a'), 2)).toBe(1);
    expect(ndcgAtK(['x', 'a'], rel('a'), 2)).toBeCloseTo(d(1), 12);
  });
});
