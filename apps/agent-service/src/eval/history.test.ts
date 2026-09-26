import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LiveTallySchema, cassetteSetDigest, type LiveTally } from '@repo/eval-harness';
import {
  HISTORY_BRANCH,
  committedCassetteDigest,
  openHistory,
  publishHistory,
  readEpoch,
  writeTally,
} from './history.js';

/**
 * The history writer against real git: a bare repository standing in for
 * GitHub and clones standing in for nightly runners. No network and no
 * GitHub — what is under test is the branch the pushes leave behind, which is
 * decided by git and by the code here, not by the host.
 */

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const DIGEST = 'd'.repeat(64);

const tally = (startedAt: string, gitSha: string, passed: boolean[]): LiveTally => ({
  kind: 'live-tally',
  suite: 'memory-recall',
  cassetteDigest: DIGEST,
  gitSha,
  startedAt,
  tasks: { 'memory-recall-001': { trials: passed, graders: { entity_merged: passed } } },
});

// Hermetic: a developer's global config (signing, hooks, a default branch)
// must not decide whether this passes.
const saved = {
  global: process.env['GIT_CONFIG_GLOBAL'],
  system: process.env['GIT_CONFIG_NOSYSTEM'],
};
beforeAll(() => {
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
});
afterAll(() => {
  for (const [key, value] of [
    ['GIT_CONFIG_GLOBAL', saved.global],
    ['GIT_CONFIG_NOSYSTEM', saved.system],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the eval-history writer', () => {
  let root: string;
  let remote: string;

  /** A clone of `main`, as `actions/checkout` leaves one. */
  const clone = (name: string): string => {
    const dir = join(root, name);
    run(root, 'clone', '--quiet', remote, dir);
    return dir;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eval-history-'));
    remote = join(root, 'remote.git');
    run(root, 'init', '--quiet', '--bare', '-b', 'main', remote);

    const seed = join(root, 'seed');
    run(root, 'init', '--quiet', '-b', 'main', seed);
    writeFileSync(join(seed, 'README.md'), 'main\n');
    run(seed, 'add', '.');
    run(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'main');
    run(seed, 'remote', 'add', 'origin', remote);
    run(seed, 'push', '--quiet', 'origin', 'main');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const remoteFiles = (): string[] =>
    run(remote, 'ls-tree', '-r', '--name-only', HISTORY_BRANCH).split('\n').filter(Boolean);

  it('starts the branch as an orphan on the first night, holding the tally and nothing of main', () => {
    const repo = clone('night-1');
    const dir = join(root, 'history-1');
    expect(openHistory({ repoDir: repo, dir })).toBe('created');

    const path = writeTally(dir, tally('2026-09-27T03:00:00.000Z', 'a'.repeat(40), [false]));
    expect(path).toBe(`live/memory-recall/${'d'.repeat(12)}/2026-09-27T030000.000Z-aaaaaaa.json`);
    expect(publishHistory({ dir })).toEqual({ status: 'pushed', files: [path] });

    expect(remoteFiles()).toEqual([path]);
    // A root commit: no parent, so no history shared with main.
    expect(run(remote, 'rev-list', '--parents', '-n', '1', HISTORY_BRANCH).split(' ')).toHaveLength(
      1,
    );
    const pushed: unknown = JSON.parse(run(remote, 'show', `${HISTORY_BRANCH}:${path}`));
    expect(LiveTallySchema.parse(pushed).tasks['memory-recall-001']?.trials).toEqual([false]);
  });

  it('appends to the existing branch on later nights, and pools what is there', () => {
    const first = clone('night-1');
    openHistory({ repoDir: first, dir: join(root, 'history-1') });
    writeTally(join(root, 'history-1'), tally('2026-09-27T03:00:00.000Z', 'a'.repeat(40), [true]));
    publishHistory({ dir: join(root, 'history-1') });

    const second = clone('night-2');
    const dir = join(root, 'history-2');
    expect(openHistory({ repoDir: second, dir })).toBe('existing');
    writeTally(dir, tally('2026-09-28T03:00:00.000Z', 'b'.repeat(40), [false]));

    expect(readEpoch(dir, 'memory-recall', DIGEST).map((t) => t.gitSha[0])).toEqual(['a', 'b']);
    expect(readEpoch(dir, 'memory-recall', 'e'.repeat(64))).toEqual([]);
    publishHistory({ dir });
    expect(remoteFiles()).toHaveLength(2);
  });

  it('rebases and retries a push another run got in first, on an existing branch and on the first night', () => {
    // Both open before either pushes: two first nights, each starting an orphan.
    const a = clone('a');
    const b = clone('b');
    expect(openHistory({ repoDir: a, dir: join(root, 'ha') })).toBe('created');
    expect(openHistory({ repoDir: b, dir: join(root, 'hb') })).toBe('created');
    writeTally(join(root, 'ha'), tally('2026-09-27T03:00:00.000Z', 'a'.repeat(40), [true]));
    writeTally(join(root, 'hb'), tally('2026-09-27T03:05:00.000Z', 'b'.repeat(40), [true]));

    expect(publishHistory({ dir: join(root, 'ha') }).status).toBe('pushed');
    expect(publishHistory({ dir: join(root, 'hb') }).status).toBe('pushed');
    expect(remoteFiles()).toHaveLength(2);
  });

  it('refuses to overwrite a tally, and publishes nothing when no run wrote one', () => {
    const repo = clone('night-1');
    const dir = join(root, 'history-1');
    openHistory({ repoDir: repo, dir });
    expect(publishHistory({ dir })).toEqual({ status: 'nothing' });

    const once = tally('2026-09-27T03:00:00.000Z', 'a'.repeat(40), [true]);
    writeTally(dir, once);
    expect(() => writeTally(dir, once)).toThrow(/already holds/);
  });

  it('refuses a tally that does not validate', () => {
    const repo = clone('night-1');
    const dir = join(root, 'history-1');
    openHistory({ repoDir: repo, dir });
    const bad = { ...tally('2026-09-27T03:00:00.000Z', 'a'.repeat(40), [true]), kind: 'other' };
    expect(() => writeTally(dir, bad as unknown as LiveTally)).toThrow();
    expect(existsSync(join(dir, 'live'))).toBe(false);
  });
});

describe('committedCassetteDigest', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cassette-digest-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is the on-disk digest of a clean checkout, and survives the files being deleted', () => {
    run(root, 'init', '--quiet', '-b', 'main');
    const dataset = join(root, 'datasets', 'memory-recall');
    mkdirSync(join(dataset, 'cassettes'), { recursive: true });
    writeFileSync(join(dataset, 'cassettes', 'a.trial-0.json'), '{"a":1}\n');
    writeFileSync(join(dataset, 'cassettes', 'b.trial-0.json'), '{"b":2}\n');
    writeFileSync(join(dataset, 'task.json'), '{}\n');
    run(root, 'add', '.');
    run(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'set');

    const onDisk = cassetteSetDigest(dataset);
    expect(committedCassetteDigest(dataset)).toBe(onDisk);

    // What the live job does before it records.
    rmSync(join(dataset, 'cassettes', 'a.trial-0.json'));
    expect(cassetteSetDigest(dataset)).not.toBe(onDisk);
    expect(committedCassetteDigest(dataset)).toBe(onDisk);
  });
});
