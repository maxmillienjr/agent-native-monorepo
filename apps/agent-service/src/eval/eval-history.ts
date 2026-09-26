import { resolve } from 'node:path';
import { createLogger } from '@repo/telemetry';
import { HISTORY_BRANCH, openHistory, publishHistory, repoRoot } from './history.js';

const logger = createLogger('eval');

/**
 * `yarn workspace @repo/agent-service eval:history <open|publish>` — the two
 * git steps around a nightly live run, for `agent-eval.yml`.
 *
 *   open     checks `eval-history` out at `EVAL_HISTORY_DIR`, creating the
 *            orphan branch if the remote has none yet
 *   publish  commits the tally the run appended there and pushes it
 *
 * The run itself (`EVAL_GATE=live yarn eval`) only writes and reads files in
 * that directory; the network half is here, so that it is one module with a
 * test against real git rather than shell in a workflow.
 */
function main(): void {
  const command = process.argv[2];
  const dir = process.env['EVAL_HISTORY_DIR'];
  if (dir === undefined || dir === '') {
    throw new Error('EVAL_HISTORY_DIR is not set; it names where eval-history is checked out');
  }
  const historyDir = resolve(dir);

  if (command === 'open') {
    const state = openHistory({ repoDir: repoRoot(), dir: historyDir });
    logger.info({ msg: 'eval.history.open', branch: HISTORY_BRANCH, state, dir: historyDir });
    return;
  }
  if (command === 'publish') {
    const result = publishHistory({ dir: historyDir });
    logger.info({ msg: 'eval.history.publish', branch: HISTORY_BRANCH, ...result });
    return;
  }
  throw new Error(`usage: eval-history <open|publish>; got ${command ?? 'nothing'}`);
}

try {
  main();
} catch (error) {
  logger.error({
    msg: 'eval.history.failed',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
