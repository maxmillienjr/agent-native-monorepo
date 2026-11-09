import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRIOR_AUTH_DATASET_DIR, cassettePath } from '@repo/eval-harness';
import { datasetDirOf } from '../suite-dirs.js';
import { compareRecorded } from './run-compare.js';

/**
 * `canary:compare` on a rotation slice (P1-H): a directory holding a few of
 * prior-auth's cassettes, as the rotation's artifact does, against the
 * committed set that `COMPARE_SUITE=prior-auth` names. Copies of committed
 * cassettes stand in for the night's recordings; nothing is recorded and no key
 * is read.
 */
describe('canary:compare with COMPARE_SUITE=prior-auth', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'compare-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('compares a slice’s cassettes with the committed ones and makes no model request', () => {
    const live = join(root, 'live');
    mkdirSync(live);
    const slice = ['pa-e0260-administrative', 'pa-e0470-ambiguous'];
    for (const task of slice) {
      copyFileSync(
        cassettePath(PRIOR_AUTH_DATASET_DIR, task, 0),
        join(live, `${task}.trial-0.json`),
      );
    }

    const output = join(root, 'out');
    const code = compareRecorded({
      liveDir: live,
      datasetDir: datasetDirOf('prior-auth'),
      outputDir: output,
    });

    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(output, 'compare-report.json'), 'utf8')) as {
      comparisons: { taskId: string; firstDivergence: unknown }[];
      missing: string[];
      modelRequests: string[];
    };
    expect(report.comparisons.map((c) => c.taskId)).toEqual(slice);
    expect(report.comparisons.every((c) => c.firstDivergence === null)).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.modelRequests).toEqual([]);
    expect(readFileSync(join(output, 'compare-summary.md'), 'utf8')).toContain(
      '**Requests to `generativelanguage.googleapis.com`:** 0.',
    );
  });

  it('is red on a slice that compared nothing', () => {
    const live = join(root, 'empty');
    mkdirSync(live);
    expect(
      compareRecorded({
        liveDir: live,
        datasetDir: datasetDirOf('prior-auth'),
        outputDir: join(root, 'out'),
      }),
    ).toBe(1);
  });
});
