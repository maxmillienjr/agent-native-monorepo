import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../stats/paired-bootstrap.js';
import { poolTallies, type LivePool, type LiveReference, type LiveTally } from './baseline.js';
import { compareLive, trialFloor, type LiveVerdict } from './compare-live.js';

const bernoulli = (random: () => number, n: number, p: number): boolean[] =>
  Array.from({ length: n }, () => random() < p);

function pool(tasks: Record<string, boolean[]>, suite = 'memory-recall'): LivePool {
  return {
    suite,
    cassetteDigest: 'c'.repeat(64),
    runs: [{ gitSha: 'abc1234', startedAt: '2026-09-27T03:00:00.000Z' }],
    tasks: Object.fromEntries(Object.entries(tasks).map(([task, trials]) => [task, { trials }])),
  };
}

function reference(tasks: Record<string, boolean[]>): LiveReference {
  return { ...pool(tasks), cassetteDigest: 'r'.repeat(64), kind: 'live-reference' };
}

const all = (n: number, value = true): boolean[] => Array.from({ length: n }, () => value);

describe('compareLive', () => {
  it('has a floor of ⌈3/δ⌉: 15 trials at δ = 0.20, 30 at 0.10', () => {
    expect(trialFloor(0.2)).toBe(15);
    expect(trialFloor(0.1)).toBe(30);
  });

  it('is insufficient-evidence below the floor, however clear the interval', () => {
    // 14 failures against 14 passes: Δ = −1 with a zero-width interval, one
    // trial short of the floor on every task.
    const result = compareLive(
      pool({ a: all(14, false), b: all(14, false) }),
      reference({ a: all(14), b: all(14) }),
    );
    expect(result.estimate).toBe(-1);
    expect(result.upper).toBe(-1);
    expect(result.verdict).toBe('insufficient-evidence');
    expect(result.tasks.map((t) => t.needs)).toEqual([
      { candidate: 1, reference: 1 },
      { candidate: 1, reference: 1 },
    ]);
  });

  it('is insufficient-evidence when one arm of one task is short', () => {
    const result = compareLive(
      pool({ a: all(40), b: all(40) }),
      reference({ a: all(40), b: all(10) }),
    );
    expect(result.verdict).toBe('insufficient-evidence');
  });

  it('is held on two all-pass arms at the floor, and regressed on a collapse', () => {
    expect(
      compareLive(pool({ a: all(15), b: all(15) }), reference({ a: all(15), b: all(15) })).verdict,
    ).toBe('held');
    expect(
      compareLive(pool({ a: all(15, false), b: all(15) }), reference({ a: all(15), b: all(15) }))
        .verdict,
    ).toBe('regressed');
  });

  it('is incomparable with no reference, another suite, or another task set', () => {
    const candidate = pool({ a: all(20), b: all(20) });
    expect(compareLive(candidate, undefined).verdict).toBe('incomparable');
    expect(
      compareLive(pool({ a: all(20), b: all(20) }, 'other'), reference({ a: all(20), b: all(20) }))
        .verdict,
    ).toBe('incomparable');
    const mismatched = compareLive(candidate, reference({ a: all(20), c: all(20) }));
    expect(mismatched.verdict).toBe('incomparable');
    expect(mismatched.reason).toMatch(/task sets differ/);
  });

  it('names tasks-fixed below 20 tasks and tasks-random from 20', () => {
    const tasks = (k: number): Record<string, boolean[]> =>
      Object.fromEntries(Array.from({ length: k }, (_, i) => [`t${i}`, all(15)]));
    expect(compareLive(pool(tasks(19)), reference(tasks(19))).regime).toBe('tasks-fixed');
    const random = compareLive(pool(tasks(20)), reference(tasks(20)));
    expect(random.regime).toBe('tasks-random');
    expect(random.verdict).toBe('held');
  });

  it('is the same verdict and interval for the same input and seed', () => {
    const random = mulberry32(3);
    const c = pool({ a: bernoulli(random, 20, 0.8), b: bernoulli(random, 20, 0.9) });
    const r = reference({ a: bernoulli(random, 20, 0.9), b: bernoulli(random, 20, 0.9) });
    expect(compareLive(c, r, { seed: 5 })).toEqual(compareLive(c, r, { seed: 5 }));
  });
});

describe('poolTallies', () => {
  const tally = (startedAt: string, a: boolean[]): LiveTally => ({
    kind: 'live-tally',
    suite: 'memory-recall',
    cassetteDigest: 'c'.repeat(64),
    gitSha: `sha-${startedAt.slice(8, 10)}`,
    startedAt,
    tasks: { a: { trials: a, graders: {} } },
  });

  it('concatenates one epoch in run order and lists the runs', () => {
    const pooled = poolTallies([
      tally('2026-09-28T03:00:00.000Z', [false]),
      tally('2026-09-27T03:00:00.000Z', [true]),
    ]);
    expect(pooled.tasks).toEqual({ a: { trials: [true, false] } });
    expect(pooled.runs.map((run) => run.gitSha)).toEqual(['sha-27', 'sha-28']);
  });

  it('refuses to pool across epochs', () => {
    expect(() =>
      poolTallies([
        tally('2026-09-27T03:00:00.000Z', [true]),
        { ...tally('2026-09-28T03:00:00.000Z', [true]), cassetteDigest: 'd'.repeat(64) },
      ]),
    ).toThrow(/across suites or epochs/);
  });
});

/**
 * The rule's operating characteristics, pre-registered in the PRD's criterion:
 * δ = 0.20, K = 2, 400 seeded simulations. Each simulation draws a reference
 * arm and a candidate arm of n trials per task at the stated true rates, the
 * same rate on both tasks, and asks the rule for a verdict. 2,000 resamples per
 * interval rather than the gate's 10,000, as in the PRD's own sketch, so the
 * suite stays in unit-test time; the verdicts are read off the same indices.
 */
function simulate(n: number, pRef: number, pCand: number): Record<LiveVerdict, number> {
  const counts: Record<LiveVerdict, number> = {
    held: 0,
    regressed: 0,
    'insufficient-evidence': 0,
    incomparable: 0,
  };
  for (let s = 0; s < 400; s += 1) {
    const random = mulberry32(0x51_0000 + s);
    const r = reference({ a: bernoulli(random, n, pRef), b: bernoulli(random, n, pRef) });
    const c = pool({ a: bernoulli(random, n, pCand), b: bernoulli(random, n, pCand) });
    counts[compareLive(c, r, { resamples: 2_000, seed: s + 1 }).verdict] += 1;
  }
  return counts;
}

describe('the decision rule at δ = 0.20, K = 2, 400 simulations', () => {
  it('holds when nothing changed at p = 0.9 and n = 18: held ≥ 75%, regressed ≤ 5%', () => {
    const counts = simulate(18, 0.9, 0.9);
    expect(counts.held / 400).toBeGreaterThanOrEqual(0.75);
    expect(counts.regressed / 400).toBeLessThanOrEqual(0.05);
  });

  it('catches a drop from 0.9 to 0.5 at n = 18: regressed ≥ 95%', () => {
    expect(simulate(18, 0.9, 0.5).regressed / 400).toBeGreaterThanOrEqual(0.95);
  });

  it('says nothing at n = 5: insufficient-evidence 100%', () => {
    expect(simulate(5, 0.9, 0.9)['insufficient-evidence']).toBe(400);
  });
});
