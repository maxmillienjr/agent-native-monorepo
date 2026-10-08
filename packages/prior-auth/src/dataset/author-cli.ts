import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLogger } from '@repo/telemetry';
import { PolicyCatalogue, loadPayer } from '../policy.js';
import { authorDataset } from './author.js';
import { PRIOR_AUTH_DATASET_DIR } from './location.js';

const logger = createLogger('author-dataset');

/**
 * `yarn workspace @repo/prior-auth author-dataset` — writes the 24 task files,
 * the 24 bundles and `bundles/labels.json` from `scenarios.ts`.
 *
 * Editing a bundle by hand and not here makes `dataset.test.ts` fail, which is
 * the point: the base64 in a bundle is unreadable, so the scenario is the
 * reviewable copy.
 */
const target = resolve(process.argv[2] ?? PRIOR_AUTH_DATASET_DIR);
const dataset = authorDataset(loadPayer(), PolicyCatalogue.load().all());

for (const [path, contents] of dataset.files) {
  const file = join(target, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

logger.info({ msg: 'author-dataset.done', target, files: dataset.files.size });
