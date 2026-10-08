import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LiveTallySchema,
  ReplayBaselineSchema,
  cassetteSetDigest,
  gateBlocks,
  renderReplayBaseline,
  type GateResult,
  type GradedReport,
} from '@repo/eval-harness';
import {
  applyGate,
  assertGateAxes,
  assertGateModel,
  readGateMode,
  readRunOutput,
  type GateMode,
} from './gate.js';

/**
 * The gate as the runner applies it: a real output directory, a real dataset
 * directory with a cassette and a baseline, and no store, model or git. The
 * digest and commit the live half would read from git are injected.
 */

type Cell = readonly [task: string, grader: string, label: 'pass' | 'fail', value: number];

function report(model: 'replay' | 'live', cells: readonly Cell[]): GradedReport {
  const tasks = [...new Set(cells.map(([task]) => task))];
  return {
    suite: 'memory-recall',
    startedAt: '2026-09-27T03:00:00.000Z',
    axes: { model, memory: 'live' },
    ...(model === 'replay'
      ? { replay: { recordedAt: '2026-09-10T00:00:00.000Z', gitSha: '021c6f2' } }
      : {}),
    tasks: tasks.map((taskId) => {
      const results = cells
        .filter(([task]) => task === taskId)
        .map(([, grader, label, value]) => ({
          grader,
          score: { label, value, explanation: `run ${Math.random()}` },
        }));
      return {
        taskId,
        trials: [{ index: 0, passed: results.every((r) => r.score.label === 'pass'), results }],
      };
    }),
  };
}

const RECORDED: readonly Cell[] = [
  ['memory-recall-001', 'entity_merged', 'pass', 1],
  ['memory-recall-001', 'episodic_row_written', 'pass', 1],
  ['tool-use-001', 'tool_trajectory_precision', 'pass', 1 / 3],
];

describe('the runner gate', () => {
  let root: string;
  let output: string;
  let dataset: string;
  let history: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gate-'));
    output = join(root, 'out');
    dataset = join(root, 'datasets', 'memory-recall');
    history = join(root, 'history');
    mkdirSync(output, { recursive: true });
    mkdirSync(join(dataset, 'cassettes'), { recursive: true });
    mkdirSync(history);
    writeFileSync(join(dataset, 'cassettes', 'memory-recall-001.trial-0.json'), '{"v":1}\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const completed = (graded: GradedReport): void => {
    writeFileSync(join(output, 'eval-report.json'), JSON.stringify(graded));
    writeFileSync(join(output, 'eval-summary.md'), '## Eval — memory-recall\n');
  };

  const gate = (mode: GateMode): GateResult =>
    applyGate({
      mode,
      outputDir: output,
      datasetDir: dataset,
      displayRoot: root,
      committedDigest: () => 'c'.repeat(64),
      gitSha: () => 'abcdef0'.padEnd(40, '0'),
      historyDir: history,
    });

  const accept = (): void => {
    completed(report('replay', RECORDED));
    expect(gate('update').verdict).toBe('updated');
  };

  it('writes the baseline on update, and then matches it', () => {
    accept();
    const baseline = ReplayBaselineSchema.parse(
      JSON.parse(readFileSync(join(dataset, 'baselines', 'replay.json'), 'utf8')),
    );
    expect(baseline.cells).toHaveLength(3);
    expect(baseline.cassetteDigest).toBe(cassetteSetDigest(dataset));

    completed(report('replay', RECORDED));
    const result = gate('replay');
    expect(result.verdict).toBe('match');
    expect(gateBlocks(result)).toBe(false);
    expect(readFileSync(join(output, 'eval-summary.md'), 'utf8')).toContain(
      '### Gate — replay: `match`',
    );
    const written = JSON.parse(readFileSync(join(output, 'eval-gate.json'), 'utf8')) as GateResult;
    expect(written.verdict).toBe('match');
  });

  it('blocks on a skipped task, naming each of its cells as missing', () => {
    accept();
    completed(
      report(
        'replay',
        RECORDED.filter(([task]) => task !== 'tool-use-001'),
      ),
    );
    const result = gate('replay');
    expect(result.verdict).toBe('differs');
    expect(gateBlocks(result)).toBe(true);
    if (result.axis === 'replay' && result.verdict === 'differs') {
      expect(result.comparison.differences.map((d) => d.kind)).toEqual(['missing']);
    }
  });

  it('blocks on a re-recorded set whose baseline was not regenerated', () => {
    accept();
    writeFileSync(join(dataset, 'cassettes', 'memory-recall-001.trial-0.json'), '{"v":2}\n');
    completed(report('replay', RECORDED));
    const result = gate('replay');
    expect(result.verdict).toBe('differs');
    expect(readFileSync(join(output, 'eval-summary.md'), 'utf8')).toContain('`stale-digest`');
  });

  it('reports every cell as unbaselined when there is no baseline yet', () => {
    completed(report('replay', RECORDED));
    const result = gate('replay');
    expect(result.verdict).toBe('differs');
    if (result.axis === 'replay' && result.verdict === 'differs') {
      expect(result.comparison.differences.every((d) => d.kind === 'unbaselined')).toBe(true);
    }
  });

  it('is aborted when eval-abort.json is present, whether or not a report is', () => {
    accept();
    for (const withReport of [false, true]) {
      rmSync(join(output, 'eval-report.json'), { force: true });
      if (withReport) completed(report('replay', RECORDED));
      else writeFileSync(join(output, 'eval-summary.md'), '## Eval — aborted\n');
      writeFileSync(
        join(output, 'eval-abort.json'),
        JSON.stringify({ cause: { code: 'cassette-miss' } }),
      );
      const result = gate('replay');
      expect(result).toEqual({
        axis: 'replay',
        verdict: 'aborted',
        reason: '`eval-abort.json` is present (`cassette-miss`)',
      });
      expect(gateBlocks(result)).toBe(true);
      expect(readFileSync(join(output, 'eval-summary.md'), 'utf8')).toContain(
        '### Gate — replay: `aborted` — blocks',
      );
    }
  });

  it('is aborted when the report was never written', () => {
    expect(readRunOutput(output)).toEqual({
      completed: false,
      reason: '`eval-report.json` was not written',
    });
    expect(gate('replay').verdict).toBe('aborted');
  });

  it('is aborted, not a crash, when the baseline does not parse', () => {
    mkdirSync(join(dataset, 'baselines'));
    writeFileSync(join(dataset, 'baselines', 'replay.json'), '{"kind":"other"}');
    completed(report('replay', RECORDED));
    const result = gate('replay');
    expect(result.verdict).toBe('aborted');
    if (result.verdict === 'aborted') expect(result.reason).toMatch(/could not run/);
  });

  it('on live, appends a tally that validates and stays green on a failed trial', () => {
    completed(
      report('live', [
        ['memory-recall-001', 'entity_merged', 'fail', 0],
        ['tool-use-001', 'tool_trajectory_precision', 'pass', 1],
      ]),
    );
    const result = gate('live');
    expect(result.verdict).toBe('incomparable');
    expect(gateBlocks(result)).toBe(false);
    if (result.axis !== 'live' || result.verdict === 'aborted') throw new Error('unreachable');

    const tally = LiveTallySchema.parse(
      JSON.parse(readFileSync(join(history, result.tally), 'utf8')),
    );
    expect(tally.cassetteDigest).toBe('c'.repeat(64));
    expect(tally.tasks['memory-recall-001']?.trials).toEqual([false]);
    expect(result.pool.runs).toHaveLength(1);
  });

  it('on live, compares the pooled epoch with a committed reference', () => {
    const reference = {
      kind: 'live-reference',
      suite: 'memory-recall',
      cassetteDigest: 'r'.repeat(64),
      runs: [],
      tasks: { 'memory-recall-001': { trials: [true] }, 'tool-use-001': { trials: [true] } },
    };
    mkdirSync(join(dataset, 'baselines'));
    writeFileSync(join(dataset, 'baselines', 'live.json'), JSON.stringify(reference));
    completed(
      report('live', [
        ['memory-recall-001', 'entity_merged', 'pass', 1],
        ['tool-use-001', 'tool_trajectory_precision', 'pass', 1],
      ]),
    );
    const result = gate('live');
    expect(result.verdict).toBe('insufficient-evidence');
    expect(readFileSync(join(output, 'eval-summary.md'), 'utf8')).toContain('14 / 14');
  });

  it('writes nothing to the history for an aborted live run', () => {
    writeFileSync(join(output, 'eval-abort.json'), '{}');
    writeFileSync(join(output, 'eval-summary.md'), '## Eval — aborted\n');
    expect(gate('live').verdict).toBe('aborted');
    expect(existsSync(join(history, 'live'))).toBe(false);
  });

  it('never leaves a baseline in the renderer’s format that the schema rejects', () => {
    accept();
    const text = readFileSync(join(dataset, 'baselines', 'replay.json'), 'utf8');
    expect(renderReplayBaseline(ReplayBaselineSchema.parse(JSON.parse(text)))).toBe(text);
  });
});

describe('readGateMode and assertGateAxes', () => {
  it('reads the three modes and refuses anything else', () => {
    expect(readGateMode({})).toBeUndefined();
    expect(readGateMode({ EVAL_GATE: '' })).toBeUndefined();
    expect(readGateMode({ EVAL_GATE: 'replay' })).toBe('replay');
    expect(() => readGateMode({ EVAL_GATE: 'strict' })).toThrow(/replay, update or live/);
  });

  it('refuses a gate on an axis it cannot judge', () => {
    const live = { model: 'live', memory: 'live' } as const;
    const replay = { model: 'replay', memory: 'live' } as const;
    expect(() => assertGateAxes('replay', live, {})).toThrow(/EVAL_CASSETTE_MODE=replay/);
    expect(() => assertGateAxes('update', { model: 'stub', memory: 'live' }, {})).toThrow();
    expect(() => assertGateAxes('live', replay, { EVAL_HISTORY_DIR: '/h' })).toThrow(/model axis/);
    expect(() => assertGateAxes('live', live, {})).toThrow(/EVAL_HISTORY_DIR/);
    expect(() => assertGateAxes('replay', replay, {})).not.toThrow();
    expect(() => assertGateAxes('live', live, { EVAL_HISTORY_DIR: '/h' })).not.toThrow();
    expect(() => assertGateAxes(undefined, live, {})).not.toThrow();
  });

  it('refuses a gate on a chat model other than the pinned one, and nothing without a gate', () => {
    const pinned = 'gemini-2.5-flash';
    for (const gate of ['live', 'replay', 'update'] as const) {
      expect(() => assertGateModel(gate, 'gemini-flash-latest', pinned)).toThrow(
        /`gemini-2\.5-flash`.*`gemini-flash-latest`/,
      );
      expect(() => assertGateModel(gate, pinned, pinned)).not.toThrow();
    }
    expect(() => assertGateModel(undefined, 'gemini-flash-latest', pinned)).not.toThrow();
  });
});
