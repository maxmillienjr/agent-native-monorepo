import { describe, expect, it } from 'vitest';
import { mulberry32 } from './paired-bootstrap.js';
import { stratifiedBootstrap } from './stratified-bootstrap.js';

/** `n` Bernoulli(p) trials as 0/1, from a fixed seed. */
const trials = (seed: number, n: number, p: number): number[] => {
  const random = mulberry32(seed);
  return Array.from({ length: n }, () => (random() < p ? 1 : 0));
};

describe('stratifiedBootstrap', () => {
  it('returns the identical interval for identical input and seed', () => {
    const a = { x: trials(1, 30, 0.8), y: trials(2, 25, 0.6) };
    const b = { x: trials(3, 30, 0.7), y: trials(4, 40, 0.6) };
    expect(stratifiedBootstrap(a, b, { seed: 11 })).toEqual(
      stratifiedBootstrap(a, b, { seed: 11 }),
    );
  });

  it('does not depend on the order the strata were written in', () => {
    const x = trials(5, 20, 0.5);
    const y = trials(6, 20, 0.9);
    const forward = stratifiedBootstrap({ x, y }, { x: y, y: x });
    const backward = stratifiedBootstrap({ y, x }, { y: x, x: y });
    expect(forward).toEqual(backward);
  });

  it('returns exactly [0, 0] for identical arms with no variance', () => {
    const a = { x: [1, 1, 1, 1, 1], y: [0, 0, 0] };
    const result = stratifiedBootstrap(a, { x: [...a.x], y: [...a.y] });
    expect([result.estimate, result.lower, result.upper]).toEqual([0, 0, 0]);
  });

  it('brackets 0 for identical arms that do vary', () => {
    const a = { x: trials(7, 50, 0.7), y: trials(8, 50, 0.4) };
    const result = stratifiedBootstrap(a, { x: [...a.x], y: [...a.y] });
    expect(result.estimate).toBe(0);
    expect(result.lower).toBeLessThan(0);
    expect(result.upper).toBeGreaterThan(0);
  });

  it('weighs every stratum at 1/K whatever its size', () => {
    // Stratum x moves by -1 on 2 trials, stratum y by 0 on 200: Δ is -0.5,
    // not the -2/202 a pooled mean would give.
    const result = stratifiedBootstrap(
      { x: [0, 0], y: Array.from({ length: 200 }, () => 1) },
      { x: [1, 1], y: Array.from({ length: 200 }, () => 1) },
    );
    expect(result.estimate).toBe(-0.5);
    expect([result.lower, result.upper]).toEqual([-0.5, -0.5]);
  });

  it('excludes 0 when the candidate is worse on every stratum', () => {
    const result = stratifiedBootstrap(
      { x: trials(9, 60, 0.4), y: trials(10, 60, 0.5) },
      { x: trials(11, 60, 0.95), y: trials(12, 60, 0.95) },
    );
    expect(result.upper).toBeLessThan(0);
    expect(result.lower).toBeLessThanOrEqual(result.estimate);
    expect(result.upper).toBeGreaterThanOrEqual(result.estimate);
  });

  it('refuses mismatched or empty strata rather than dropping one', () => {
    expect(() => stratifiedBootstrap({ x: [1] }, { y: [1] })).toThrow(/same strata/);
    expect(() => stratifiedBootstrap({ x: [1], y: [1] }, { x: [1] })).toThrow(/same strata/);
    expect(() => stratifiedBootstrap({ x: [] }, { x: [1] })).toThrow(/empty/);
    expect(() => stratifiedBootstrap({}, {})).toThrow(/at least one/);
  });
});
