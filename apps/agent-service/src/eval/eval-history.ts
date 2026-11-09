import { resolve } from 'node:path';
import { createLogger } from '@repo/telemetry';
import { HISTORY_BRANCH, openHistory, publishHistory, repoRoot } from './history.js';
import { githubOutputLines, runSlice } from './rotation.js';

const logger = createLogger('eval');

/**
 * `yarn workspace @repo/agent-service eval:history <open|slice|publish>` — the
 * git steps around a nightly live run, and the rotation's choice of tasks, for
 * `agent-eval.yml`.
 *
 *   open     checks `eval-history` out at `EVAL_HISTORY_DIR`, creating the
 *            orphan branch if the remote has none yet
 *   slice    picks tonight's prior-auth and red-team tasks from that checkout
 *            and the night's spend, and writes them to `$GITHUB_OUTPUT`
 *            (P1-H; `rotation.ts` says what it reads)
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
  if (command === 'slice') {
    const plan = runSlice();
    logger.info({
      msg: 'eval.history.slice',
      status: plan.status,
      outputs: githubOutputLines(plan),
    });
    return;
  }
  if (command === 'publish') {
    const result = publishHistory({ dir: historyDir });
    logger.info({ msg: 'eval.history.publish', branch: HISTORY_BRANCH, ...result });
    return;
  }
  throw new Error(`usage: eval-history <open|slice|publish>; got ${command ?? 'nothing'}`);
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
