import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MEMORY_RECALL_SUITE } from '@repo/eval-harness';
import { createLogger } from '@repo/telemetry';
import { MODEL_HOST, watchForModelRequests } from '../cassette-deps.js';
import { datasetDirOf } from '../suite-dirs.js';
import { compareDirectories, renderComparisonSummary } from './compare-cassettes.js';

const logger = createLogger('canary-compare');

/**
 * One live directory of recorded cassettes against one suite's committed set,
 * written as `compare-report.json` and `compare-summary.md`. Returns the exit
 * code: 1 when a request reached the model host or nothing was compared.
 *
 * It reads files and makes no model call. The replay tier's watcher is on for
 * the whole comparison, and a request to the model host fails it.
 */
export function compareRecorded(options: {
  readonly liveDir: string;
  readonly datasetDir: string;
  readonly outputDir: string;
}): number {
  const { outputDir } = options;
  mkdirSync(outputDir, { recursive: true });
  for (const file of ['compare-report.json', 'compare-summary.md']) {
    rmSync(resolve(outputDir, file), { force: true });
  }

  const reached = watchForModelRequests((target) =>
    logger.error({ msg: 'compare.live-call', target }),
  );
  const result = compareDirectories(resolve(options.liveDir), options.datasetDir);
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

/**
 * `yarn workspace @repo/agent-service canary:compare` — a live run's recorded
 * decisions against the committed cassettes (P1-E).
 *
 *   COMPARE_LIVE_DIR     the live run's recorded cassettes (required)
 *   COMPARE_SUITE        whose committed set to compare with (default
 *                        memory-recall); the rotation's slices name
 *                        `prior-auth` and `red-team` (P1-H)
 *   COMPARE_OUTPUT_DIR   where the files go (default `compare-results`)
 */
function main(): number {
  const liveDir = process.env['COMPARE_LIVE_DIR'];
  if (liveDir === undefined || liveDir === '') {
    throw new Error('COMPARE_LIVE_DIR names no directory of live cassettes');
  }
  const suite = process.env['COMPARE_SUITE'] || MEMORY_RECALL_SUITE;
  return compareRecorded({
    liveDir,
    datasetDir: datasetDirOf(suite),
    outputDir: resolve(process.env['COMPARE_OUTPUT_DIR'] ?? 'compare-results'),
  });
}

// Only as a script: the test imports `compareRecorded` without running this.
if (process.argv[1]?.endsWith('run-compare.js') === true) {
  try {
    process.exitCode = main();
  } catch (error) {
    logger.error({
      msg: 'compare.fatal',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
