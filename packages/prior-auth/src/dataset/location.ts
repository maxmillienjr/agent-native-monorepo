import { fileURLToPath } from 'node:url';

/**
 * Where the dataset is committed: beside the memory-recall suite, because the
 * bundles and labels are evaluation data and the policies are service
 * configuration (P3-D, "Layout"). Resolved from `src/` and `dist/` alike.
 */
export const PRIOR_AUTH_DATASET_DIR = fileURLToPath(
  new URL('../../../eval-harness/datasets/prior-auth', import.meta.url),
);
