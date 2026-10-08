import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ReplayBaselineSchema,
  cassetteSetDigest,
  digestFiles,
  renderReplayBaseline,
  replayBaseline,
  type GradedReport,
} from './baseline.js';
import { compareReplay, countDifferences } from './compare-replay.js';

type Result = readonly [
  grader: string,
  label: 'pass' | 'fail',
  value: number,
  explanation?: string,
];

/**
 * A replayed report shaped like `eval-report.json`, explanations included, so
 * that what the gate ignores is actually present in its input.
 */
function report(tasks: Record<string, readonly (readonly Result[])[]>): GradedReport {
  return {
    suite: 'memory-recall',
    startedAt: '2026-09-26T00:00:00.000Z',
    axes: { model: 'replay', memory: 'live' },
    replay: { recordedAt: '2026-09-10T00:00:00.000Z', gitSha: '021c6f2' },
    tasks: Object.entries(tasks).map(([taskId, trials]) => ({
      taskId,
      trials: trials.map((results, index) => ({
        index,
        passed: results.every(([, label]) => label === 'pass'),
        results: results.map(([grader, label, value, explanation]) => ({
          grader,
          score: { label, value, ...(explanation === undefined ? {} : { explanation }) },
        })),
      })),
    })),
  };
}

const DIGEST = 'a'.repeat(64);

const recorded = report({
  'memory-recall-001': [
    [
      ['episodic_row_written', 'pass', 1, '2 episodes row(s) for run 1111'],
      ['entity_merged', 'pass', 1],
    ],
  ],
  'tool-use-001': [
    [
      ['trajectory_precision', 'pass', 7 / 9],
      ['tool_trajectory_precision', 'pass', 1 / 3],
    ],
  ],
});

describe('compareReplay', () => {
  const baseline = replayBaseline(recorded, DIGEST);

  it('returns match for an identical table, whatever the explanations say', () => {
    const rerun = report({
      'memory-recall-001': [
        [
          ['episodic_row_written', 'pass', 1, '2 episodes row(s) for run 2222'],
          ['entity_merged', 'pass', 1, 'something else entirely'],
        ],
      ],
      'tool-use-001': [
        [
          ['trajectory_precision', 'pass', 7 / 9],
          ['tool_trajectory_precision', 'pass', 1 / 3],
        ],
      ],
    });
    expect(compareReplay(rerun, baseline, DIGEST)).toEqual({
      verdict: 'match',
      runCells: 4,
      baselineCells: 4,
      differences: [],
    });
  });

  it('names a pass that became a fail as regressed', () => {
    const run = report({
      'memory-recall-001': [
        [
          ['episodic_row_written', 'pass', 1],
          ['entity_merged', 'fail', 0],
        ],
      ],
      'tool-use-001': recorded.tasks[1]!.trials.map((t) =>
        t.results.map((r) => [r.grader, r.score.label, r.score.value] as const),
      ),
    });
    const result = compareReplay(run, baseline, DIGEST);
    expect(result.verdict).toBe('differs');
    expect(result.differences).toEqual([
      {
        kind: 'regressed',
        cell: { task: 'memory-recall-001', trial: 0, grader: 'entity_merged' },
        baseline: { label: 'pass', value: 1 },
        run: { label: 'fail', value: 0 },
      },
    ]);
  });

  it('names a fail that became a pass as improved, and blocks on it', () => {
    const failing = replayBaseline(report({ t: [[['g', 'fail', 0.2]]] }), DIGEST);
    const result = compareReplay(report({ t: [[['g', 'pass', 0.2]]] }), failing, DIGEST);
    expect(result.verdict).toBe('differs');
    expect(result.differences.map((d) => d.kind)).toEqual(['improved']);
  });

  it('names a value that moved under an unchanged label as value-moved', () => {
    const run = report({
      'memory-recall-001': recorded.tasks[0]!.trials.map((t) =>
        t.results.map((r) => [r.grader, r.score.label, r.score.value] as const),
      ),
      'tool-use-001': [
        [
          ['trajectory_precision', 'pass', 8 / 9],
          ['tool_trajectory_precision', 'pass', 1 / 3],
        ],
      ],
    });
    const result = compareReplay(run, baseline, DIGEST);
    expect(result.differences).toEqual([
      {
        kind: 'value-moved',
        cell: { task: 'tool-use-001', trial: 0, grader: 'trajectory_precision' },
        baseline: { label: 'pass', value: 7 / 9 },
        run: { label: 'pass', value: 8 / 9 },
      },
    ]);
  });

  it('names every cell of a task that stopped running, and a deleted assertion, as missing', () => {
    // The Problem section's probe: tool-use-001 skipped, one assertion removed.
    const run = report({ 'memory-recall-001': [[['episodic_row_written', 'pass', 1]]] });
    const result = compareReplay(run, baseline, DIGEST);
    expect(result.verdict).toBe('differs');
    expect(countDifferences(result.differences)).toMatchObject({ missing: 3 });
    expect(
      result.differences.map((d) => ('cell' in d ? `${d.cell.task}/${d.cell.grader}` : '')),
    ).toEqual([
      'memory-recall-001/entity_merged',
      'tool-use-001/tool_trajectory_precision',
      'tool-use-001/trajectory_precision',
    ]);
  });

  it('names a cell the baseline does not have as unbaselined', () => {
    const run = report({
      'memory-recall-001': recorded.tasks[0]!.trials.map((t) =>
        t.results.map((r) => [r.grader, r.score.label, r.score.value] as const),
      ),
      'tool-use-001': recorded.tasks[1]!.trials.map((t) =>
        t.results.map((r) => [r.grader, r.score.label, r.score.value] as const),
      ),
      'new-task-001': [[['outcome_must_be', 'pass', 1]]],
    });
    const result = compareReplay(run, baseline, DIGEST);
    expect(result.differences).toEqual([
      {
        kind: 'unbaselined',
        cell: { task: 'new-task-001', trial: 0, grader: 'outcome_must_be' },
        run: { label: 'pass', value: 1 },
      },
    ]);
  });

  it('names a re-recorded set as stale-digest even when every cell matches', () => {
    const result = compareReplay(recorded, baseline, 'b'.repeat(64));
    expect(result.verdict).toBe('differs');
    expect(result.differences).toEqual([
      { kind: 'stale-digest', baseline: DIGEST, current: 'b'.repeat(64) },
    ]);
  });
});

describe('the replay baseline file', () => {
  it('round-trips through its schema, one cell per line in sorted order', () => {
    const text = renderReplayBaseline(replayBaseline(recorded, DIGEST));
    const parsed = ReplayBaselineSchema.parse(JSON.parse(text));
    expect(parsed).toEqual(replayBaseline(recorded, DIGEST));
    const cellLines = text.split('\n').filter((line) => line.startsWith('    {'));
    expect(cellLines).toHaveLength(4);
    expect(cellLines[0]).toBe(
      '    {"task":"memory-recall-001","trial":0,"grader":"entity_merged","label":"pass","value":1},',
    );
  });

  it('is written only from a replayed run', () => {
    expect(() =>
      replayBaseline({ ...recorded, axes: { model: 'live', memory: 'live' } }, DIGEST),
    ).toThrow(/model axis `live`/);
  });

  it('keeps the conventions commit as provenance, and does not compare it', () => {
    const baseline = replayBaseline({ ...recorded, genAiSemconvCommit: 'abc123' }, DIGEST);
    expect(baseline.semconvCommit).toBe('abc123');
    expect(renderReplayBaseline(baseline)).toContain('  "semconvCommit": "abc123",\n');
    const bumped = { ...recorded, genAiSemconvCommit: 'def456' };
    expect(compareReplay(bumped, baseline, DIGEST).verdict).toBe('match');
  });
});

describe('the cassette digest', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('does not depend on the order the files were listed in', () => {
    const a = { path: 'a.trial-0.json', bytes: bytes('{"a":1}') };
    const b = { path: 'b.trial-0.json', bytes: bytes('{"b":1}') };
    expect(digestFiles([a, b])).toBe(digestFiles([b, a]));
  });

  it('moves when a byte or a name moves', () => {
    const base = digestFiles([{ path: 'a.json', bytes: bytes('x') }]);
    expect(digestFiles([{ path: 'a.json', bytes: bytes('y') }])).not.toBe(base);
    expect(digestFiles([{ path: 'b.json', bytes: bytes('x') }])).not.toBe(base);
  });

  it('reads the cassettes directory of a dataset, and nothing beside it', () => {
    dir = mkdtempSync(join(tmpdir(), 'digest-'));
    mkdirSync(join(dir, 'cassettes'));
    writeFileSync(join(dir, 'cassettes', 't.trial-0.json'), 'x');
    writeFileSync(join(dir, 'task.json'), 'not a cassette');
    expect(cassetteSetDigest(dir)).toBe(
      digestFiles([{ path: 't.trial-0.json', bytes: bytes('x') }]),
    );
  });
});
