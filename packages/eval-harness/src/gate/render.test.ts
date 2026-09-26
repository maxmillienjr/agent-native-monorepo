import { describe, expect, it } from 'vitest';
import type { LivePool, LiveReference } from './baseline.js';
import { compareLive } from './compare-live.js';
import { gateBlocks, renderGateSection, renderPool, type GateResult } from './render.js';

const DIGEST = 'f'.repeat(64);

const pool: LivePool = {
  suite: 'memory-recall',
  cassetteDigest: DIGEST,
  runs: [1, 2, 3, 4, 5].map((day) => ({
    gitSha: `${day}`.repeat(40),
    startedAt: `2026-10-0${day}T03:00:00.000Z`,
  })),
  tasks: {
    'memory-recall-001': { trials: [true, true, true, true, true] },
    'tool-use-001': { trials: [true, false, true, true, true] },
  },
};

describe('gateBlocks', () => {
  it('blocks on replay for anything but match and updated', () => {
    const comparison = {
      verdict: 'match',
      runCells: 1,
      baselineCells: 1,
      differences: [],
    } as const;
    const replay = { axis: 'replay', baseline: 'b', cassetteDigest: DIGEST, comparison } as const;
    expect(gateBlocks({ ...replay, verdict: 'match' })).toBe(false);
    expect(gateBlocks({ ...replay, verdict: 'differs' })).toBe(true);
    expect(
      gateBlocks({
        axis: 'replay',
        verdict: 'updated',
        baseline: 'b',
        cassetteDigest: DIGEST,
        cells: 1,
      }),
    ).toBe(false);
    expect(gateBlocks({ axis: 'replay', verdict: 'aborted', reason: 'x' })).toBe(true);
  });

  it('blocks on live only for regressed and aborted', () => {
    const comparison = compareLive(pool, undefined);
    const live = { axis: 'live', reference: 'r', tally: 't', pool, comparison } as const;
    expect(gateBlocks({ ...live, verdict: 'insufficient-evidence' })).toBe(false);
    expect(gateBlocks({ ...live, verdict: 'incomparable' })).toBe(false);
    expect(gateBlocks({ ...live, verdict: 'held' })).toBe(false);
    expect(gateBlocks({ ...live, verdict: 'regressed' })).toBe(true);
    expect(gateBlocks({ axis: 'live', verdict: 'aborted', reason: 'x' })).toBe(true);
  });
});

describe('renderGateSection', () => {
  it('prints each replay difference as a row with both sides', () => {
    const result: GateResult = {
      axis: 'replay',
      verdict: 'differs',
      baseline: 'datasets/memory-recall/baselines/replay.json',
      cassetteDigest: DIGEST,
      comparison: {
        verdict: 'differs',
        runCells: 10,
        baselineCells: 21,
        differences: [
          { kind: 'stale-digest', baseline: 'e'.repeat(64), current: DIGEST },
          {
            kind: 'missing',
            cell: { task: 'tool-use-001', trial: 0, grader: 'trajectory_precision' },
            baseline: { label: 'pass', value: 7 / 9 },
          },
        ],
      },
    };
    const text = renderGateSection(result);
    expect(text).toContain('### Gate — replay: `differs` — blocks');
    expect(text).toContain('1 `stale-digest`, 1 `missing`');
    expect(text).toContain(
      '| `missing` | `tool-use-001` | 0 | `trajectory_precision` | pass 0.778 | — |',
    );
    expect(text).toContain('EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval');
  });

  it('names the regime and the trials still needed on live, and never says passed', () => {
    const reference: LiveReference = {
      ...pool,
      kind: 'live-reference',
      cassetteDigest: 'e'.repeat(64),
    };
    const comparison = compareLive(pool, reference);
    const text = renderGateSection({
      axis: 'live',
      verdict: comparison.verdict,
      reference: 'live.json',
      tally: 't.json',
      pool,
      comparison,
    });
    expect(comparison.verdict).toBe('insufficient-evidence');
    expect(text).toContain('**Regime `tasks-fixed`** — the interval is about these 2 tasks only');
    expect(text).toContain('| `tool-use-001` | 4/5 | 4/5 | 10 / 10 |');
    expect(text).toContain("P1-E's canary");
    expect(text).not.toMatch(/pass(ed|es)\b/i);
  });
});

describe('renderPool', () => {
  it('prints the pooled 5×2 rate with the five runs', () => {
    const text = renderPool(pool);
    expect(text).toContain('**Pooled live pass rate: 90% over 5 trials × 2 tasks**, from 5 run(s)');
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(5);
    expect(text).toContain('- `2026-10-01T03:00:00.000Z` at `1111111`');
  });
});
