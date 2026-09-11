import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EvalHarness,
  describeAxes,
  loadMemoryRecallSuite,
  renderJUnitReport,
  renderJsonReport,
  renderMarkdownSummary,
  type MemoryOutcome,
} from '@repo/eval-harness';
import { createLogger } from '@repo/telemetry';
import { loadEnvFile } from '../load-env.js';
import { createAgentServiceHarness } from './agent-harness.js';

const logger = createLogger('eval');

/**
 * `yarn eval` — runs the suite locally and writes the three reports.
 *
 * Two things have to be true before a number out of here means anything, and
 * both have failed silently in this repository before:
 *
 *   - `.env` is read, so a `GOOGLE_API_KEY` in the file reaches the trial. It
 *     used to reach nothing on the Node path, and a stale export from a shell
 *     rc shadowed it for a whole debugging session.
 *   - Turbo's `eval` task declares `GOOGLE_API_KEY`. Turbo runs in
 *     `envMode: strict`, so a task receives only the variables its `env` array
 *     names; without the declaration every trial runs the canned model set and
 *     reports on canned strings.
 *
 * The axes are logged before the first trial and printed in every report, so a
 * run on the stub set is never mistaken for a working one.
 */
async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '..', '..'));

  const trials = Number(process.env['EVAL_TRIALS'] ?? 5);
  const outputDir = resolve(process.env['EVAL_OUTPUT_DIR'] ?? 'eval-results');

  const agent = await createAgentServiceHarness();

  try {
    const axes = agent.axes();
    logger.info({ msg: 'eval.start', axes: describeAxes(axes), trials });

    if (axes.model !== 'live') {
      logger.warn({
        msg: 'eval.model.stub',
        detail:
          'GOOGLE_API_KEY did not reach this process; every trial will run the canned model set',
      });
    }

    const report = await new EvalHarness<MemoryOutcome>({
      agent,
      suite: loadMemoryRecallSuite(trials),
      onTrial: (trial) =>
        logger.info({
          msg: 'eval.trial',
          task: trial.taskId,
          trial: trial.index + 1,
          passed: trial.passed,
          failed: trial.results
            .filter((result) => result.score.label === 'fail')
            .map((result) => result.grader),
        }),
    }).run();

    // On the console as well as in the three files. A task that left the run is
    // the one thing a reader scanning stdout for the pass rate has to see, and
    // the rate is higher precisely because the task is missing from it.
    for (const skipped of report.skipped) {
      logger.warn({
        msg: 'eval.task.skipped',
        task: skipped.taskId,
        problems: skipped.problems,
      });
    }

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, 'eval-report.json'), renderJsonReport(report));
    writeFileSync(resolve(outputDir, 'eval-report.xml'), renderJUnitReport(report));
    writeFileSync(resolve(outputDir, 'eval-summary.md'), renderMarkdownSummary(report));

    logger.info({
      msg: 'eval.done',
      axes: describeAxes(report.axes),
      passRate: report.passRate,
      tasksRun: report.tasks.length,
      tasksSkipped: report.skipped.map((skipped) => skipped.taskId),
      outputDir,
    });

    // A failing suite is a failing command. The gate that decides *which*
    // failures block a pull request is P1-D's; this is the local signal.
    if (report.passRate < 1) process.exitCode = 1;
  } finally {
    await agent.close();
  }
}

main().catch((error: unknown) => {
  logger.error({
    msg: 'eval.fatal',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
