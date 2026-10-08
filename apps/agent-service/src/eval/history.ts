import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  LiveTallySchema,
  cassettesDir,
  digestFiles,
  epochDir,
  tallyPath,
  type LiveTally,
} from '@repo/eval-harness';

/**
 * The live evidence store: an orphan `eval-history` branch, appended to by the
 * nightly live job and read by anyone with `git` (P1-D).
 *
 * A branch rather than artifacts, because an epoch at one trial a night takes
 * weeks to reach the sample-size floor and artifacts expire first; and rather
 * than a third-party store, because that needs a second secret on the nightly
 * and an account a reader cannot inspect. Orphan, so it shares no history with
 * `main` and a checkout of it holds data and nothing else. Nothing gates on the
 * branch directly: a reference is promoted from it into a committed file by a
 * reviewed pull request.
 */
export const HISTORY_BRANCH = 'eval-history';

/** Who the nightly commits as. The branch holds data a workflow wrote, and says so. */
const IDENTITY = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
  '-c',
  'commit.gpgsign=false',
];

/**
 * The environment every git call here runs with: the process's, minus `GIT_*`.
 * Git exports `GIT_DIR` to hooks and to `rebase --exec`, and an inherited one
 * overrides discovery from `cwd` — the history worktree would then commit into
 * whatever repository the caller was inside (`.context/conventions.md`).
 */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string'
    ? stderr
    : Buffer.isBuffer(stderr)
      ? stderr.toString('utf8')
      : '';
}

export function repoRoot(cwd: string = process.cwd()): string {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/**
 * The digest of the cassette set committed at `ref`, as `cassetteSetDigest`
 * would compute it from a clean checkout of that commit.
 *
 * From git rather than from disk because the live job deletes the committed
 * cassettes before it records — a trial that throws writes no cassette, and a
 * committed file left in its place would pass for a fresh one — so by the time
 * the tally is written the working tree holds that night's recordings, not the
 * set whose epoch the night belongs to. The epoch of a live run is the set
 * committed at the commit it ran.
 */
export function committedCassetteDigest(datasetDir: string, ref = 'HEAD'): string {
  const root = repoRoot(datasetDir);
  const dir = relative(root, cassettesDir(datasetDir)).split('\\').join('/');
  const listed = git(root, ['ls-tree', '--name-only', ref, '--', `${dir}/`])
    .split('\n')
    .filter((path) => path.endsWith('.json'));
  return digestFiles(
    listed.map((path) => ({
      path: path.slice(dir.length + 1),
      bytes: execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], {
        cwd: root,
        env: gitEnv(),
      }),
    })),
  );
}

/**
 * Checks the history branch out into `dir` as a worktree of `repoDir`, or
 * starts it as an orphan when the remote has no such branch yet.
 *
 * A worktree rather than a clone, so that the push reuses the credentials the
 * checkout step left in the repository's config and needs none of its own. The
 * first nightly creates the branch; nothing else ever should.
 */
export function openHistory(options: {
  readonly repoDir: string;
  readonly dir: string;
  readonly remote?: string;
  readonly branch?: string;
  /**
   * False for a reader. Only the nightly starts the branch; a promotion run
   * against a remote that has none must say so, not leave an empty local one.
   */
  readonly create?: boolean;
}): 'existing' | 'created' {
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? HISTORY_BRANCH;
  const tracking = `refs/remotes/${remote}/${branch}`;

  try {
    git(options.repoDir, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${tracking}`]);
  } catch (error) {
    if (!/couldn't find remote ref/i.test(stderrOf(error))) throw error;
    if (options.create === false) {
      throw new Error(
        `${remote} has no ${branch} branch yet; the first nightly live run creates it`,
      );
    }
    git(options.repoDir, ['worktree', 'add', '--quiet', '--orphan', '-b', branch, options.dir]);
    return 'created';
  }

  git(options.repoDir, ['worktree', 'add', '--quiet', '-B', branch, options.dir, tracking]);
  return 'existing';
}

/**
 * Writes one tally where the pooling will look for it, and returns the path
 * relative to the history root.
 *
 * Append-only: a file that already exists is refused rather than replaced.
 * Two runs cannot share a start time and a commit, so a collision means
 * something wrote the same evidence twice, and overwriting would hide it.
 */
export function writeTally(historyDir: string, tally: LiveTally): string {
  const valid = LiveTallySchema.parse(tally);
  const path = tallyPath(valid);
  const absolute = join(historyDir, path);
  if (existsSync(absolute)) throw new Error(`the history already holds ${path}`);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(valid, null, 2)}\n`);
  return path;
}

/**
 * Every tally in one epoch directory, each validated: the branch is written by
 * a workflow, and a file on it is input from another process.
 *
 * The directory is named by twelve characters of the digest; a tally whose
 * full digest differs is dropped rather than pooled, so a prefix collision
 * cannot mix two cassette sets.
 */
export function readEpoch(historyDir: string, suite: string, cassetteDigest: string): LiveTally[] {
  return readEpochDir(join(historyDir, epochDir(suite, cassetteDigest))).filter(
    (tally) => tally.suite === suite && tally.cassetteDigest === cassetteDigest,
  );
}

export function readEpochDir(dir: string): LiveTally[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => LiveTallySchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8'))));
}

/**
 * Commits whatever the run appended under `live/` and pushes it.
 *
 * A rejected push is fetched, rebased and retried. Every tally has its own
 * file name, so a rebase over another run's commit cannot conflict — including
 * the first night, when two runs could each have started the orphan branch.
 * `nothing` when no tally was written, which is every aborted run.
 */
export function publishHistory(options: {
  readonly dir: string;
  readonly remote?: string;
  readonly branch?: string;
  readonly attempts?: number;
}): { readonly status: 'nothing' } | { readonly status: 'pushed'; readonly files: string[] } {
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? HISTORY_BRANCH;
  const attempts = options.attempts ?? 3;

  if (!existsSync(join(options.dir, 'live'))) return { status: 'nothing' };
  git(options.dir, ['add', '--all', '--', 'live']);
  const files = git(options.dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (files.length === 0) return { status: 'nothing' };

  git(options.dir, [
    ...IDENTITY,
    'commit',
    '--quiet',
    '-m',
    `live tally: ${files.map((file) => file.split('/').pop()).join(', ')}`,
  ]);

  for (let attempt = 1; ; attempt += 1) {
    try {
      git(options.dir, ['push', '--quiet', remote, `HEAD:refs/heads/${branch}`]);
      return { status: 'pushed', files };
    } catch (error) {
      if (attempt >= attempts) throw error;
      const tracking = `refs/remotes/${remote}/${branch}`;
      git(options.dir, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${tracking}`]);
      git(options.dir, [...IDENTITY, 'rebase', '--quiet', tracking]);
    }
  }
}
