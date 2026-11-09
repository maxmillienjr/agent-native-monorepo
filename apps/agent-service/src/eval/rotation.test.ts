import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CassetteSchema, type Cassette } from '@repo/agent-cassette';
import { PRIOR_AUTH_DATASET_DIR, type LiveTally } from '@repo/eval-harness';
import { committedCassetteDigest, readEpoch, writeTally } from './history.js';
import {
  NOT_RECORDED_HEADING,
  ROTATION_RESERVE,
  coverage,
  githubOutputLines,
  memoryRecallCeiling,
  planRotation,
  readDailyLimit,
  readNightSpend,
  rotationBudget,
  rotationTasks,
  runSlice,
  selectSlice,
  taskCost,
  type RotationTask,
} from './rotation.js';

/**
 * The rotation's choices against fakes: a stubbed history, a fixture
 * `eval-live` artifact and a canary result. No model, no key, no store. The
 * last block reads the suites and cassettes committed at `HEAD`, through git,
 * as the job does.
 */

const pa = (id: string, cost: number, trials = 0): RotationTask => ({
  suite: 'prior-auth',
  id,
  cost,
  trials,
});
const rt = (id: string, cost: number, trials = 0): RotationTask => ({
  suite: 'red-team',
  id,
  cost,
  trials,
});

/** A small stand-in for the two suites, in file order: two free tasks and five priced ones. */
const SUITES: readonly RotationTask[] = [
  pa('pa-a-administrative', 0),
  pa('pa-a-ambiguous', 1),
  pa('pa-a-contradicted', 1),
  pa('pa-b-administrative', 0),
  pa('pa-b-ambiguous', 1),
  rt('rt-001', 3),
  rt('rt-003', 6),
];

/** The suites after the given tasks each gained one trial: a night's tally. */
const after = (tasks: readonly RotationTask[], ran: readonly string[]): RotationTask[] =>
  tasks.map((task) => (ran.includes(task.id) ? { ...task, trials: task.trials + 1 } : task));

describe('selectSlice', () => {
  it('on an empty epoch takes tasks in suite order up to the budget, and every zero-cost task', () => {
    const slice = selectSlice(SUITES, 2);
    expect(slice.tasks).toEqual({
      'prior-auth': [
        'pa-a-administrative',
        'pa-a-ambiguous',
        'pa-a-contradicted',
        'pa-b-administrative',
      ],
      'red-team': [],
    });
    expect(slice.calls).toBe(2);
  });

  it('takes a cheaper task behind one that did not fit', () => {
    const slice = selectSlice(SUITES, 5);
    // Prior-auth comes first and leaves 2, so rt-001 (3) is skipped. At 6 it fits.
    expect(slice.tasks['prior-auth']).toHaveLength(5);
    expect(slice.tasks['red-team']).toEqual([]);
    expect(slice.skipped).toEqual([
      { id: 'rt-001', cost: 3 },
      { id: 'rt-003', cost: 6 },
    ]);
    expect(selectSlice(SUITES, 6).tasks['red-team']).toEqual(['rt-001']);
  });

  it('returns the same slice again after a night with no tally', () => {
    // A skipped, paused or aborted night pushed nothing, so coverage did not move.
    expect(selectSlice(SUITES, 2)).toEqual(selectSlice(SUITES, 2));
  });

  it('moves on to the least-covered tasks after a night that was tallied', () => {
    const first = selectSlice(SUITES, 2);
    const second = selectSlice(after(SUITES, Object.values(first.tasks).flat()), 2);
    // pa-b-ambiguous is the one priced task left at zero trials that fits;
    // rt-001 does not fit the 1 call left, so it goes to the first task at one
    // trial, pa-a-ambiguous.
    expect(second.tasks).toEqual({
      'prior-auth': [
        'pa-a-administrative',
        'pa-a-ambiguous',
        'pa-b-administrative',
        'pa-b-ambiguous',
      ],
      'red-team': [],
    });
    expect(second.calls).toBe(2);
    expect(second.skipped.map((task) => task.id)).toEqual([
      'rt-001',
      'rt-003',
      'pa-a-contradicted',
    ]);
  });

  it('starts from the first task on a new digest', () => {
    // A re-record opens a new epoch: every task's coverage reads zero again.
    const covered = after(
      SUITES,
      SUITES.map((task) => task.id),
    );
    const fresh = covered.map((task) => ({ ...task, trials: 0 }));
    expect(selectSlice(fresh, 2)).toEqual(selectSlice(SUITES, 2));
  });

  it('puts a task added to a suite first', () => {
    const covered = after(
      SUITES,
      SUITES.map((task) => task.id),
    );
    const added = [...covered.slice(0, 5), pa('pa-c-ambiguous', 1), ...covered.slice(5)];
    expect(selectSlice(added, 1).tasks['prior-auth']).toEqual([
      'pa-a-administrative',
      'pa-b-administrative',
      'pa-c-ambiguous',
    ]);
  });

  it('lists a task costing more than the budget in skipped, and does not take it', () => {
    const slice = selectSlice([rt('rt-003', 6), rt('rt-001', 3)], 4);
    expect(slice.tasks['red-team']).toEqual(['rt-001']);
    expect(slice.skipped).toEqual([{ id: 'rt-003', cost: 6 }]);
  });

  it('returns an empty slice when no task with a model call fits', () => {
    const slice = selectSlice(SUITES, 0);
    expect(slice.tasks).toEqual({ 'prior-auth': [], 'red-team': [] });
    expect(slice.calls).toBe(0);
    expect(slice.skipped.map((task) => task.id)).toEqual([
      'pa-a-ambiguous',
      'pa-a-contradicted',
      'pa-b-ambiguous',
      'rt-001',
      'rt-003',
    ]);
  });
});

describe('a task’s cost and coverage', () => {
  const cassette = (taskId: string, seams: readonly string[]): Cassette =>
    CassetteSchema.parse({
      header: {
        formatVersion: 3,
        taskId,
        trialIndex: 0,
        recordedAt: '2026-11-09T00:00:00.000Z',
        gitSha: 'f'.repeat(40),
        axes: { model: 'live', memory: 'live' },
        chatModel: 'gemini-3.5-flash-lite',
        embeddingModel: 'gemini-embedding-001',
        embeddingDimensions: 768,
      },
      decisions: seams.map((seam) => ({
        seam,
        requestHash: '0'.repeat(64),
        request: {},
        response: { kind: 'value', value: null },
        latencyMs: 1,
      })),
    });

  it('is budgets.modelCalls when the task declares one', () => {
    expect(taskCost({ id: 'rt-003', budgets: { modelCalls: 6 } }, [])).toBe(6);
  });

  it('is otherwise the generateContent seams in its committed cassette', () => {
    const set = [
      cassette('pa-x', ['assess.criteria']),
      cassette('pa-y', []),
      cassette('rt-x', ['embed', 'plan.callLlm', 'act.selectTool', 'act.tool', 'embed']),
    ];
    expect(taskCost({ id: 'pa-x' }, set)).toBe(1);
    expect(taskCost({ id: 'pa-y' }, set)).toBe(0);
    expect(taskCost({ id: 'rt-x' }, set)).toBe(2);
    expect(() => taskCost({ id: 'pa-z' }, set)).toThrow(/no committed cassette/);
  });

  it('counts each task’s trials over the epoch’s tallies', () => {
    const tally = (tasks: Record<string, boolean[]>): LiveTally => ({
      kind: 'live-tally',
      suite: 'prior-auth',
      cassetteDigest: 'c'.repeat(64),
      gitSha: 'f'.repeat(40),
      startedAt: '2026-11-10T08:00:00.000Z',
      tasks: Object.fromEntries(
        Object.entries(tasks).map(([task, trials]) => [task, { trials, graders: {} }]),
      ),
    });
    expect(coverage([])).toEqual({});
    expect(coverage([tally({ a: [true] }), tally({ a: [false], b: [true, true] })])).toEqual({
      a: 2,
      b: 2,
    });
  });
});

describe('the budget step', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rotation-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const liveDir = (files: Record<string, unknown>): string => {
    const dir = join(root, 'eval-live');
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(body));
    }
    return dir;
  };
  /** The part of `eval-report.json` the step reads: P1-F's per-trial usage. */
  const report = (calls: readonly number[]): unknown => ({
    suite: 'memory-recall',
    usage: {
      checked: true,
      trials: calls.map((modelCalls) => ({ modelCalls, embeddingCalls: 2 })),
    },
  });

  it('computes L − S − R from the eval-live report and the canary result', () => {
    const spend = readNightSpend({
      liveDir: liveDir({ 'eval-report.json': report([3, 5, 4]) }),
      canaryResult: 'success',
      liveCeiling: () => 17,
    });
    expect(spend).toMatchObject({ kind: 'measured', live: 12, canary: 1 });
    expect(ROTATION_RESERVE).toBe(1);
    expect(rotationBudget(20, spend)).toEqual({ spent: 13, budget: 6 });
    // A canary that did not run spent nothing; a failed one may have.
    expect(
      readNightSpend({
        liveDir: liveDir({ 'eval-report.json': report([3, 5, 4]) }),
        canaryResult: 'skipped',
        liveCeiling: () => 17,
      }),
    ).toMatchObject({ live: 12, canary: 0 });
    expect(rotationBudget(10, spend)).toEqual({ spent: 13, budget: 0 });
  });

  it('uses the ceilings when eval-live aborted for another cause, and 0 on a per-day 429', () => {
    const other = readNightSpend({
      liveDir: liveDir({ 'eval-abort.json': { cause: { code: 'provider-unavailable' } } }),
      canaryResult: 'failure',
      liveCeiling: () => 17,
    });
    expect(other).toMatchObject({ kind: 'ceiling', live: 17, canary: 1 });
    expect(rotationBudget(46, other).budget).toBe(27);

    const exhausted = readNightSpend({
      liveDir: liveDir({ 'eval-abort.json': { cause: { code: 'daily-quota' } } }),
      canaryResult: 'success',
      liveCeiling: () => 17,
    });
    expect(exhausted.kind).toBe('exhausted');
    expect(rotationBudget(1000, exhausted).budget).toBe(0);

    const missing = readNightSpend({
      liveDir: join(root, 'not-downloaded'),
      canaryResult: 'success',
      liveCeiling: () => 17,
    });
    expect(missing).toMatchObject({ kind: 'ceiling', live: 17 });
  });

  it('reads memory-recall’s ceilings as 17 calls a trial', () => {
    expect(memoryRecallCeiling(1)).toBe(17);
    expect(memoryRecallCeiling(2)).toBe(34);
  });

  it('reads L as a whole number, and empty as not recorded', () => {
    expect(readDailyLimit(undefined)).toBeUndefined();
    expect(readDailyLimit('')).toBeUndefined();
    expect(readDailyLimit(' 20 ')).toBe(20);
    expect(() => readDailyLimit('about 20')).toThrow(/whole number/);
  });

  it('with L empty writes the "not run" summary, reads nothing and runs no yarn eval', () => {
    const githubOutput = join(root, 'github-output');
    const output = join(root, 'rotation');
    const plan = runSlice(
      {
        EVAL_ROTATION_DAILY_LIMIT: '',
        ROTATION_OUTPUT_DIR: output,
        GITHUB_OUTPUT: githubOutput,
        // Neither is set: with no limit, neither is read.
      },
      {
        tasks: () => {
          throw new Error('read the history');
        },
        liveCeiling: () => {
          throw new Error('read the artifact');
        },
      },
    );
    expect(plan.status).toBe('not-recorded');
    expect(readFileSync(join(output, 'rotation-summary.md'), 'utf8')).toMatch(
      new RegExp(`^## ${NOT_RECORDED_HEADING}\n`),
    );
    // The workflow runs each suite's `yarn eval` only on a non-empty list.
    expect(readFileSync(githubOutput, 'utf8')).toBe(
      'run=false\nprior_auth=\nred_team=\nbudget=\ncalls=0\n',
    );
  });

  it('writes the slice as GITHUB_OUTPUT lines and the summary prints L, S, R and the budget', () => {
    const githubOutput = join(root, 'github-output');
    const output = join(root, 'rotation');
    const plan = runSlice(
      {
        EVAL_ROTATION_DAILY_LIMIT: '20',
        EVAL_HISTORY_DIR: join(root, 'history'),
        ROTATION_LIVE_DIR: liveDir({ 'eval-report.json': report([3, 5, 4]) }),
        ROTATION_CANARY_RESULT: 'success',
        ROTATION_OUTPUT_DIR: output,
        GITHUB_OUTPUT: githubOutput,
      },
      { tasks: () => SUITES },
    );
    expect(plan.status).toBe('run');
    expect(readFileSync(githubOutput, 'utf8')).toBe(
      [
        'run=true',
        'prior_auth=pa-a-administrative,pa-a-ambiguous,pa-a-contradicted,pa-b-administrative,pa-b-ambiguous',
        'red_team=rt-001',
        'budget=6',
        'calls=6',
        '',
      ].join('\n'),
    );
    const summary = readFileSync(join(output, 'rotation-summary.md'), 'utf8');
    expect(summary).toContain('## Rotation — 6 of 6 calls on the live model');
    expect(summary).toContain(
      "| 20 | 13 (12 from `eval-live`'s report, 1 for `eval-canary`) | 1 | 6 |",
    );
    expect(summary).toContain('| red-team | `rt-001` | 3 | 0 |');
    expect(summary).toContain('**Did not fit tonight** (0 trial(s) in the epoch): `rt-003` (6).');
  });

  it('runs nothing, and says so, when no task with a model call fits', () => {
    const plan = planRotation({
      limit: '14',
      spend: () => ({ kind: 'measured', live: 12, canary: 1, source: 'fixture' }),
      tasks: () => SUITES,
    });
    expect(plan.status).toBe('nothing-fits');
    expect(githubOutputLines(plan)).toEqual([
      'run=false',
      'prior_auth=',
      'red_team=',
      'budget=0',
      'calls=0',
    ]);
  });
});

describe('the suites as committed at HEAD', () => {
  let history: string;
  beforeEach(() => {
    history = mkdtempSync(join(tmpdir(), 'rotation-history-'));
  });
  afterEach(() => rmSync(history, { recursive: true, force: true }));

  it('costs prior-auth from its cassettes and the red team from its budgets', () => {
    const tasks = rotationTasks(history);
    const priorAuth = tasks.filter((task) => task.suite === 'prior-auth');
    expect(priorAuth).toHaveLength(24);
    expect(priorAuth.filter((task) => task.cost === 0).map((task) => task.id)).toEqual([
      'pa-e0260-administrative',
      'pa-e0470-administrative',
      'pa-e0601-administrative',
      'pa-k0823-administrative',
    ]);
    expect(priorAuth.reduce((sum, task) => sum + task.cost, 0)).toBe(20);
    expect(tasks.filter((task) => task.suite === 'red-team')).toEqual([
      rt('rt-001', 3),
      rt('rt-002', 3),
      rt('rt-003', 6),
    ]);
  });

  it('reads coverage from the epoch the committed set names, and from no other', () => {
    const digest = committedCassetteDigest(PRIOR_AUTH_DATASET_DIR);
    const tally = (cassetteDigest: string): LiveTally => ({
      kind: 'live-tally',
      suite: 'prior-auth',
      cassetteDigest,
      gitSha: 'f'.repeat(40),
      startedAt: `2026-11-10T08:00:00.${cassetteDigest === digest ? '000' : '001'}Z`,
      tasks: { 'pa-e0260-ambiguous': { trials: [true], graders: {} } },
    });
    writeTally(history, tally(digest));
    writeTally(history, tally('0'.repeat(64)));
    expect(readEpoch(history, 'prior-auth', digest)).toHaveLength(1);

    const tasks = rotationTasks(history);
    expect(tasks.find((task) => task.id === 'pa-e0260-ambiguous')?.trials).toBe(1);
    expect(tasks.filter((task) => task.trials > 0)).toHaveLength(1);
  });
});
