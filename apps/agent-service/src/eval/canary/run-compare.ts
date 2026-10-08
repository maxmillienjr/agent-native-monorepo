import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MEMORY_RECALL_DATASET_DIR } from '@repo/eval-harness';
import { createLogger } from '@repo/telemetry';
import { MODEL_HOST, watchForModelRequests } from '../cassette-deps.js';
import { compareDirectories, renderComparisonSummary } from './compare-cassettes.js';

const logger = createLogger('canary-compare');

/**
 * `yarn workspace @repo/agent-service canary:compare` — the nightly live run's
 * recorded decisions against the committed cassettes (P1-E).
 *
 *   COMPARE_LIVE_DIR     the live job's recorded cassettes (required)
 *   COMPARE_OUTPUT_DIR   where the files go (default `compare-results`)
 *
 * It reads files and makes no model call. The replay tier's watcher is on for
 * the whole run, and a request to the model host fails it.
 */
function main(): number {
  const liveDir = process.env['COMPARE_LIVE_DIR'];
  if (liveDir === undefined || liveDir === '') {
    throw new Error('COMPARE_LIVE_DIR names no directory of live cassettes');
  }
  const outputDir = resolve(process.env['COMPARE_OUTPUT_DIR'] ?? 'compare-results');
  mkdirSync(outputDir, { recursive: true });
  for (const file of ['compare-report.json', 'compare-summary.md']) {
    rmSync(resolve(outputDir, file), { force: true });
  }

  const reached = watchForModelRequests((target) =>
    logger.error({ msg: 'compare.live-call', target }),
  );
  const result = compareDirectories(resolve(liveDir), MEMORY_RECALL_DATASET_DIR);
  const requests = reached();

  writeFileSync(
    resolve(outputDir, 'compare-report.json'),
    `${JSON.stringify({ ...result, modelRequests: requests }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(outputDir, 'compare-summary.md'),
    renderComparisonSummary(result.comparisons, result) +
      `\n**Requests to \`${MODEL_HOST}\`:** ${requests.length}.\n`,
  );
  logger.info({
    msg: 'compare.done',
    comparisons: result.comparisons.length,
    missing: result.missing,
    modelRequests: requests.length,
    outputDir,
  });

  if (requests.length > 0) return 1;
  // An empty artifact compares nothing, and a green job that compared nothing
  // is the failure the live job's skip-not-pass rule exists for.
  return result.comparisons.length === 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  logger.error({
    msg: 'compare.fatal',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
