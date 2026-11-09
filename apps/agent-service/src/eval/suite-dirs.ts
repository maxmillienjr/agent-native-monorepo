import {
  MEMORY_RECALL_DATASET_DIR,
  MEMORY_RECALL_SUITE,
  PRIOR_AUTH_DATASET_DIR,
  PRIOR_AUTH_SUITE,
  RED_TEAM_DATASET_DIR,
  RED_TEAM_SUITE,
} from '@repo/eval-harness';

/**
 * Each suite's dataset directory, by the name a tally is filed under.
 *
 * For the commands that act on one suite's files and not on a run: promoting a
 * live reference and comparing recorded decisions. Each defaults to
 * memory-recall, which was the only suite with a live tier before P1-H.
 */
const DATASET_DIRS: Readonly<Record<string, string>> = {
  [MEMORY_RECALL_SUITE]: MEMORY_RECALL_DATASET_DIR,
  [PRIOR_AUTH_SUITE]: PRIOR_AUTH_DATASET_DIR,
  [RED_TEAM_SUITE]: RED_TEAM_DATASET_DIR,
};

export function datasetDirOf(suite: string): string {
  const dir = DATASET_DIRS[suite];
  if (dir === undefined) {
    throw new Error(
      `unknown suite \`${suite}\`: expected ${Object.keys(DATASET_DIRS)
        .map((name) => `\`${name}\``)
        .join(', ')}`,
    );
  }
  return dir;
}
