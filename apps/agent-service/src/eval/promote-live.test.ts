import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveReferenceSchema, loadLiveReference, type LiveTally } from '@repo/eval-harness';
import { writeTally } from './history.js';
import { promoteEpoch } from './promote-live.js';

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

  it('refuses an epoch the history does not hold, or one named too briefly to be unique', () => {
    const history = join(root, 'history');
    writeTally(history, tally(EPOCH, '2026-09-27T03:00:00.000Z', [true]));
    const base = { historyDir: history, suite: 'memory-recall', datasetDir: join(root, 'd') };
    expect(() => promoteEpoch({ ...base, digest: OTHER })).toThrow(/no epoch bbbbbbbbbbbb/);
    expect(() => promoteEpoch({ ...base, digest: 'aaaa' })).toThrow(/at least 12/);
  });
});
