import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LiveReferenceSchema,
  PRIOR_AUTH_DATASET_DIR,
  liveReferencePath,
  loadLiveReference,
  type LiveTally,
} from '@repo/eval-harness';
import { writeTally } from './history.js';
import { promoteEpoch, promoteLive, readPromoteArgs } from './promote-live.js';
import { datasetDirOf } from './suite-dirs.js';

const tally = (digest: string, startedAt: string, trials: boolean[]): LiveTally => ({
  kind: 'live-tally',
  suite: 'memory-recall',
  cassetteDigest: digest,
  gitSha: `${startedAt.slice(8, 10)}`.padEnd(40, '0'),
  startedAt,
  tasks: {
    'memory-recall-001': { trials, graders: {} },
    'tool-use-001': { trials: trials.map((t) => !t), graders: {} },
  },
});

describe('promoteEpoch', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'promote-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const EPOCH = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);

  it('pools one epoch into a committed reference, and leaves every other epoch out', () => {
    const history = join(root, 'history');
    writeTally(history, tally(EPOCH, '2026-09-28T03:00:00.000Z', [false]));
    writeTally(history, tally(EPOCH, '2026-09-27T03:00:00.000Z', [true]));
    writeTally(history, tally(OTHER, '2026-09-29T03:00:00.000Z', [true]));

    const dataset = join(root, 'dataset');
    const { path, reference } = promoteEpoch({
      historyDir: history,
      suite: 'memory-recall',
      digest: EPOCH.slice(0, 12),
      datasetDir: dataset,
    });

    expect(path).toBe(join(dataset, 'baselines', 'live.json'));
    expect(LiveReferenceSchema.parse(JSON.parse(readFileSync(path, 'utf8')))).toEqual(reference);
    expect(loadLiveReference(path)).toEqual(reference);
    expect(reference.cassetteDigest).toBe(EPOCH);
    expect(reference.runs.map((run) => run.startedAt)).toEqual([
      '2026-09-27T03:00:00.000Z',
      '2026-09-28T03:00:00.000Z',
    ]);
    expect(reference.tasks['memory-recall-001']?.trials).toEqual([true, false]);
  });

  it('promotes a prior-auth epoch with --suite, into prior-auth’s baselines', () => {
    const history = join(root, 'history');
    const priorAuth = (startedAt: string, task: string): LiveTally => ({
      kind: 'live-tally',
      suite: 'prior-auth',
      cassetteDigest: EPOCH,
      gitSha: 'f'.repeat(40),
      startedAt,
      tasks: { [task]: { trials: [true], graders: { no_false_approval: [true] } } },
    });
    // Two nights of the rotation, each a different slice, and a memory-recall
    // epoch with the same digest that must stay out.
    writeTally(history, priorAuth('2026-11-10T08:00:00.000Z', 'pa-e0260-ambiguous'));
    writeTally(history, priorAuth('2026-11-11T08:00:00.000Z', 'pa-e0470-ambiguous'));
    writeTally(history, tally(EPOCH, '2026-11-10T08:00:00.000Z', [true]));

    const dirs: string[] = [];
    const { suite, path, reference } = promoteLive({
      argv: ['--suite', 'prior-auth', EPOCH.slice(0, 12)],
      historyDir: history,
      datasetDirOf: (name) => {
        dirs.push(name);
        return join(root, 'datasets', name);
      },
    });

    expect(suite).toBe('prior-auth');
    expect(dirs).toEqual(['prior-auth']);
    expect(path).toBe(join(root, 'datasets', 'prior-auth', 'baselines', 'live.json'));
    expect(loadLiveReference(path)).toEqual(reference);
    expect(reference.suite).toBe('prior-auth');
    expect(Object.keys(reference.tasks)).toEqual(['pa-e0260-ambiguous', 'pa-e0470-ambiguous']);

    // The resolver the command uses names the committed file.
    expect(liveReferencePath(datasetDirOf('prior-auth'))).toBe(
      join(PRIOR_AUTH_DATASET_DIR, 'baselines', 'live.json'),
    );
  });

  it('reads memory-recall when no --suite is given, as before', () => {
    expect(readPromoteArgs([EPOCH])).toEqual({ suite: 'memory-recall', digest: EPOCH });
    expect(readPromoteArgs([EPOCH, '--suite', 'red-team'])).toEqual({
      suite: 'red-team',
      digest: EPOCH,
    });
    expect(() => readPromoteArgs([])).toThrow(/usage/);
    expect(() => readPromoteArgs(['--suite'])).toThrow(/names no suite/);
    expect(() => readPromoteArgs([EPOCH, OTHER])).toThrow(/usage/);
    expect(() => datasetDirOf('prior-auth [pa-e0260-ambiguous]')).toThrow(/unknown suite/);

    const history = join(root, 'history');
    writeTally(history, tally(EPOCH, '2026-09-27T03:00:00.000Z', [true]));
    const { suite, path } = promoteLive({
      argv: [EPOCH.slice(0, 12)],
      historyDir: history,
      datasetDirOf: (name) => join(root, 'datasets', name),
    });
    expect(suite).toBe('memory-recall');
    expect(path).toBe(join(root, 'datasets', 'memory-recall', 'baselines', 'live.json'));
  });

  it('refuses an epoch the history does not hold, or one named too briefly to be unique', () => {
    const history = join(root, 'history');
    writeTally(history, tally(EPOCH, '2026-09-27T03:00:00.000Z', [true]));
    const base = { historyDir: history, suite: 'memory-recall', datasetDir: join(root, 'd') };
    expect(() => promoteEpoch({ ...base, digest: OTHER })).toThrow(/no epoch bbbbbbbbbbbb/);
    expect(() => promoteEpoch({ ...base, digest: 'aaaa' })).toThrow(/at least 12/);
  });
});
