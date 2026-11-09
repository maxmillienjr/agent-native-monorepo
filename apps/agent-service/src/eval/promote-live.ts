import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  LiveReferenceSchema,
  MEMORY_RECALL_SUITE,
  liveReferencePath,
  liveRegime,
  poolTallies,
  regimeFloor,
  LIVE_DELTA,
  type LiveReference,
} from '@repo/eval-harness';
import { createLogger } from '@repo/telemetry';
import { openHistory, readEpochDir, repoRoot } from './history.js';
import { datasetDirOf } from './suite-dirs.js';

const logger = createLogger('eval');

/**
 * Pools one epoch of `eval-history` into the reference the live gate compares
 * against, and writes it for review.
 *
 * Only this reference is ever compared against, and nothing moves it except a
 * pull request that commits the file this writes. The alternative — the
 * previous epoch by default — would let a regressed epoch become the reference
 * for the next, which launders the regression one re-record later.
 */
export function promoteEpoch(options: {
  readonly historyDir: string;
  readonly suite: string;
  /** A prefix of the epoch's digest, at least the twelve characters its directory is named by. */
  readonly digest: string;
  readonly datasetDir: string;
}): { readonly path: string; readonly reference: LiveReference } {
  if (options.digest.length < 12) {
    throw new Error(
      `name the epoch by at least 12 characters of its digest; got ${options.digest}`,
    );
  }
  const suiteDir = join(options.historyDir, 'live', options.suite);
  const epochs = existsSync(suiteDir) ? readdirSync(suiteDir) : [];
  const dir = epochs.find((epoch) => options.digest.startsWith(epoch));
  if (dir === undefined) {
    throw new Error(
      `eval-history has no epoch ${options.digest.slice(0, 12)} for ${options.suite}; ` +
        `it has [${epochs.join(', ')}]`,
    );
  }

  const tallies = readEpochDir(join(suiteDir, dir)).filter((tally) =>
    tally.cassetteDigest.startsWith(options.digest),
  );
  if (tallies.length === 0)
    throw new Error(`epoch ${dir} holds no tally matching ${options.digest}`);

  const reference = LiveReferenceSchema.parse({ kind: 'live-reference', ...poolTallies(tallies) });
  const path = liveReferencePath(options.datasetDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(reference, null, 2)}\n`);
  return { path, reference };
}

const USAGE = 'usage: yarn eval:promote-live [--suite <name>] <cassette digest>';

/**
 * The command line: `[--suite <name>] <digest>`, the suite defaulting to
 * memory-recall, which was the only suite with a live tier before P1-H.
 */
export function readPromoteArgs(argv: readonly string[]): {
  readonly suite: string;
  readonly digest: string;
} {
  const rest = [...argv];
  let suite = MEMORY_RECALL_SUITE;
  const flag = rest.indexOf('--suite');
  if (flag >= 0) {
    const name = rest[flag + 1];
    if (name === undefined || name.startsWith('--'))
      throw new Error(`${USAGE}; --suite names no suite`);
    suite = name;
    rest.splice(flag, 2);
  }
  const [digest, ...extra] = rest;
  if (digest === undefined || extra.length > 0) throw new Error(USAGE);
  return { suite, digest };
}

/**
 * Promotes the epoch the arguments name into the suite's `baselines/live.json`.
 * `datasetDirOf` is a parameter so a test can point it away from the
 * committed datasets.
 */
export function promoteLive(options: {
  readonly argv: readonly string[];
  readonly historyDir: string;
  readonly datasetDirOf?: (suite: string) => string;
}): { readonly suite: string; readonly path: string; readonly reference: LiveReference } {
  const { suite, digest } = readPromoteArgs(options.argv);
  const datasetDir = (options.datasetDirOf ?? datasetDirOf)(suite);
  return { suite, ...promoteEpoch({ historyDir: options.historyDir, suite, digest, datasetDir }) };
}

/**
 * `yarn eval:promote-live [--suite <name>] <digest>`.
 *
 * Reads `EVAL_HISTORY_DIR` when it names a checkout of the branch, and
 * otherwise checks `origin/eval-history` out into a temporary worktree and
 * removes it afterwards.
 */
function main(): void {
  const argv = process.argv.slice(2);
  // Before any checkout, so a typo costs no fetch.
  readPromoteArgs(argv);

  const root = repoRoot();
  const given = process.env['EVAL_HISTORY_DIR'];
  const temporary = given === undefined || given === '';
  const historyDir = temporary ? join(mkdtempSync(join(tmpdir(), 'eval-history-')), 'h') : given;

  try {
    if (temporary) openHistory({ repoDir: root, dir: historyDir, create: false });
    const { suite, path, reference } = promoteLive({ argv, historyDir });
    const tasks = Object.entries(reference.tasks);
    const floor = regimeFloor(liveRegime(tasks.length), LIVE_DELTA);
    logger.info({
      msg: 'eval.promote-live',
      suite,
      wrote: relative(root, path),
      epoch: reference.cassetteDigest.slice(0, 12),
      runs: reference.runs.length,
      trials: Object.fromEntries(tasks.map(([task, { trials }]) => [task, trials.length])),
      floor,
      detail:
        'review and commit the file; a task under the floor keeps every live verdict at ' +
        'insufficient-evidence until the reference has that many trials',
    });
  } finally {
    if (temporary) {
      if (existsSync(historyDir)) {
        execFileSync('git', ['worktree', 'remove', '--force', historyDir], { cwd: root });
      }
      rmSync(dirname(historyDir), { recursive: true, force: true });
    }
  }
}

// Only as a script: the test imports `promoteEpoch` without running this.
if (process.argv[1]?.endsWith('promote-live.js') === true) {
  try {
    main();
  } catch (error) {
    logger.error({
      msg: 'eval.promote-live.failed',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}
