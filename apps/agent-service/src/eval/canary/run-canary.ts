import { resolve } from 'node:path';
import { createLogger } from '@repo/telemetry';
import { loadEnvFile } from '../../load-env.js';
import { loadCanaryBaseline, writeCanaryBaseline } from './baseline.js';
import { readProbeSelection, runCanary } from './runner.js';

const logger = createLogger('canary');

/**
 * `yarn canary` — the model-drift canary (P1-E).
 *
 * Four probes against the two pinned ids and the floating alias: `models.get`
 * on all three, one `generateContent` on each chat id for `modelVersion`, and
 * 21 `embedContent` calls compared bit for bit with the vectors the committed
 * cassettes recorded. It needs a key and no stores.
 *
 *   GOOGLE_API_KEY       required; there is no stub fallback
 *   CANARY_OUTPUT_DIR    where the files go (default `canary-results`)
 *   CANARY_PROBES        a comma-separated subset of the four probes
 *   CANARY_BASELINE      `update` rewrites the baseline from what was observed
 *
 * Exit 1 when a pinned probe is `changed`, `gone` or `unobserved`, or the run
 * aborted; the files in the output directory say which.
 */
async function main(): Promise<'passed' | 'failed' | 'aborted'> {
  loadEnvFile(resolve(process.cwd(), '..', '..'));
  const outputDir = resolve(process.env['CANARY_OUTPUT_DIR'] ?? 'canary-results');
  const mode = process.env['CANARY_BASELINE'] ?? '';
  if (mode !== '' && mode !== 'update') {
    throw new Error(`CANARY_BASELINE must be \`update\` or unset; got \`${mode}\``);
  }

  const end = await runCanary({
    outputDir,
    apiKey: process.env['GOOGLE_API_KEY'],
    baseline: () => loadCanaryBaseline(),
    probes: readProbeSelection(process.env['CANARY_PROBES']),
    ...(mode === 'update' ? { update: (baseline) => writeCanaryBaseline(baseline) } : {}),
    onAbort: (_error, abort) =>
      logger.error({
        msg: 'canary.aborted',
        error: abort.error.message,
        cause: abort.cause?.code,
        requests: abort.requests,
      }),
  });

  (end === 'passed' ? logger.info : logger.error).call(logger, {
    msg: 'canary.done',
    result: end,
    outputDir,
  });
  return end;
}

main().then(
  (end) => {
    if (end !== 'passed') process.exitCode = 1;
  },
  (error: unknown) => {
    logger.error({
      msg: 'canary.fatal',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  },
);
