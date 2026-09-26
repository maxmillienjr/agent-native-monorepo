import { describe, it, expect } from 'vitest';
import { mulberry32, pairedBootstrap, pairsToResolve } from './paired-bootstrap.js';

/** A fixed, irregular series of per-query scores. */
const scores = (seed: number, n: number): number[] => {
  const random = mulberry32(seed);
  return Array.from({ length: n }, () => Math.round(random() * 10) / 10);
};

describe('pairedBootstrap', () => {
  it('returns the identical interval for identical input and seed', () => {
    const a = scores(1, 200);
    const b = scores(2, 200);
    expect(pairedBootstrap(a, b, { seed: 7 })).toEqual(pairedBootstrap(a, b, { seed: 7 }));
  });

  it('returns a different interval for a different seed', () => {
    const a = scores(1, 200);
    const b = scores(2, 200);
    const first = pairedBootstrap(a, b, { seed: 7 });
    const second = pairedBootstrap(a, b, { seed: 8 });
    expect(first.mean).toBe(second.mean);
    expect([first.lower, first.upper]).not.toEqual([second.lower, second.upper]);
  });

  it('returns exactly [0, 0] for two identical systems', () => {
    const a = scores(3, 200);
    const result = pairedBootstrap(a, [...a]);
    expect(result.mean).toBe(0);
    expect(result.sd).toBe(0);
    expect([result.lower, result.upper]).toEqual([0, 0]);
  });

  it('excludes 0 when one system wins on every query', () => {
    const b = scores(4, 50).map((value) => value * 0.5);
    const a = b.map((value, i) => value + 0.05 + (i % 3) * 0.1);
    const result = pairedBootstrap(a, b);
    expect(result.lower).toBeGreaterThan(0);
    expect(result.upper).toBeGreaterThan(result.lower);
    expect(result.mean).toBeGreaterThanOrEqual(result.lower);
    expect(result.mean).toBeLessThanOrEqual(result.upper);
  });

  it('brackets the point estimate and reports its inputs', () => {
    const result = pairedBootstrap(scores(5, 120), scores(6, 120));
    expect(result.n).toBe(120);
    expect(result.resamples).toBe(10_000);
    expect(result.confidence).toBe(0.95);
    expect(result.lower).toBeLessThanOrEqual(result.mean);
    expect(result.upper).toBeGreaterThanOrEqual(result.mean);
  });

  it('refuses unpaired or empty input rather than truncating', () => {
    expect(() => pairedBootstrap([1, 2], [1])).toThrow(/equal-length/);
    expect(() => pairedBootstrap([], [])).toThrow(/at least one/);
  });
});

describe('pairsToResolve', () => {
  it('is the n at which 1.96 sd / sqrt(n) falls below the distance', () => {
    // 1.959964 * 0.3 / 0.042 = 14.0; squared 196.
    expect(pairsToResolve(0.3, 0.042)).toBe(196);
    expect(pairsToResolve(0.3, -0.042)).toBe(196);
  });

  it('has no answer at zero distance and needs one pair at zero spread', () => {
    expect(pairsToResolve(0.3, 0)).toBeNull();
    expect(pairsToResolve(0, 0.05)).toBe(1);
  });
});
