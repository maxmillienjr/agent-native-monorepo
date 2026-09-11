import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EvalHarness,
  MEMORY_RECALL_DATASET_DIR,
  capTrialsToCassettes,
  describeAxes,
  detectAxes,
  loadMemoryRecallSuite,
  readCassetteMode,
  renderJUnitReport,
  renderJsonReport,
  renderMarkdownSummary,
  skippedTasks,
  trialsFor,
  type Axes,
  type MemoryOutcome,
  type ReplayProvenance,
  type Suite,
} from '@repo/eval-harness';
import { createLogger } from '@repo/telemetry';
import { loadEnvFile } from '../load-env.js';
import { createAgentServiceHarness } from './agent-harness.js';
import {
  MODEL_HOST,
  gitHead,
  recordingDecks,
  replayDecks,
  watchForModelRequests,
  type TrialDecks,
} from './cassette-deps.js';

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
 *   - Turbo's `eval` task declares every variable this file reads. Turbo runs
 *     in `envMode: strict`, so a task receives only the variables its `env`
 *     array names; without the declaration `GOOGLE_API_KEY` makes every trial
 *     run the canned model set, and `EVAL_TRIALS`, `EVAL_OUTPUT_DIR` and
 *     `EVAL_CASSETTE_MODE` simply do not arrive.
 *
 * The axes are logged before the first trial and printed in every report, so a
 * run on the stub set is never mistaken for a working one — and a replayed run
 * additionally names the cassette set it came out of.
 */
async function main(): Promise<void> {
  loadEnvFile(resolve(process.cwd(), '..', '..'));

  const mode = readCassetteMode();
  const trials = Number(process.env['EVAL_TRIALS'] ?? 5);
  const outputDir = resolve(process.env['EVAL_OUTPUT_DIR'] ?? 'eval-results');
  const axes = detectAxes();

  const liveCalls =
    mode === 'replay'
      ? watchForModelRequests((target) => logger.error({ msg: 'eval.replay.live-call', target }))
      : () => [];
  const { suite, decks, replay } = prepare(mode, trials, axes);

  const agent = await createAgentServiceHarness(decks);

  try {
    logger.info({ msg: 'eval.start', axes: describeAxes(axes), trials, cassettes: mode });

    if (axes.model === 'stub') {
      logger.warn({
        msg: 'eval.model.stub',
        detail:
          'GOOGLE_API_KEY did not reach this process; every trial will run the canned model set',
      });
    }

    if (axes.model === 'replay') {
      logger.warn({
        msg: 'eval.model.replay',
        detail:
          'every trial is served from a recorded cassette: this measures the graph against a ' +
          'frozen sample, and cannot catch the model getting worse or the client breaking',
        recordedAt: replay?.recordedAt,
        gitSha: replay?.gitSha,
      });
    }

    const report = await new EvalHarness<MemoryOutcome>({
      agent,
      suite,
      ...(replay === undefined ? {} : { replay }),
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

    // A replayed suite that reached the model is not a cheap suite that worked;
    // it is an expensive one that lied about which axis produced its number.
    const reached = liveCalls();
    if (reached.length > 0) {
      throw new Error(
        `replay made ${reached.length} request(s) to ${MODEL_HOST}: ${reached.join(', ')}`,
      );
    }

    // A failing suite is a failing command. The gate that decides *which*
    // failures block a pull request is P1-D's; this is the local signal.
    if (report.passRate < 1) process.exitCode = 1;
  } finally {
    await agent.close();
  }
}

/**
 * The suite, the decks and the provenance for one run, decided before the Nest
 * context is built.
 *
 * Before, because a replay against an incompatible or missing cassette set must
 * fail without having reset a database, and because the decorator has to be
 * installed on the service the moment the harness exists.
 */
function prepare(
  mode: 'off' | 'record' | 'replay',
  trials: number,
  axes: Axes,
): {
  suite: Suite<MemoryOutcome>;
  decks: TrialDecks | undefined;
  replay: ReplayProvenance | undefined;
} {
  const suite = loadMemoryRecallSuite(trials);

  if (mode === 'off') return { suite, decks: undefined, replay: undefined };

  if (mode === 'record') {
    const head = gitHead();
    if (head.dirty) {
      // Not a refusal: the sha still names a real commit and the cassette is
      // still a genuine recording. It is a warning because the set's provenance
      // is then approximate, and a reader of the report cannot tell.
      logger.warn({
        msg: 'eval.record.dirty-tree',
        detail: 'recording from a dirty working tree; the header names the commit, not the tree',
        gitSha: head.sha,
      });
    }

    return {
      suite,
      decks: recordingDecks({ datasetDir: MEMORY_RECALL_DATASET_DIR, axes, gitSha: head.sha }),
      replay: undefined,
    };
  }

  // A task has as many replayable trials as it has cassettes, and a skipped
  // task needs none — it never runs.
  const capped = capTrialsToCassettes(suite, MEMORY_RECALL_DATASET_DIR);
  const skipped = new Set(skippedTasks(capped.tasks, axes).map((task) => task.taskId));
  const decks = replayDecks(
    MEMORY_RECALL_DATASET_DIR,
    capped.tasks
      .filter((task) => !skipped.has(task.id))
      .map((task) => ({ taskId: task.id, trials: trialsFor(task, capped) })),
  );

  return { suite: capped, decks, replay: decks.provenance() };
}

main().catch((error: unknown) => {
  logger.error({
    msg: 'eval.fatal',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
