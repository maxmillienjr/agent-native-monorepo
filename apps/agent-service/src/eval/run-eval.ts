import 'reflect-metadata';
import { resolve } from 'node:path';
import {
  EvalHarness,
  MEMORY_RECALL_DATASET_DIR,
  MEMORY_RECALL_SUITE,
  assertExpectedAxes,
  capTrialsToCassettes,
  describeAxes,
  detectAxes,
  loadMemoryRecallSuite,
  readCassetteMode,
  skippedTasks,
  trialsFor,
  type Axes,
  type MemoryOutcome,
  type ReplayProvenance,
  type Suite,
} from '@repo/eval-harness';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { createLogger, initTelemetry, shutdownTelemetry } from '@repo/telemetry';
import { loadEnvFile } from '../load-env.js';
import { explainAbort } from './abort-cause.js';
import { createAgentServiceHarness } from './agent-harness.js';
import {
  MODEL_HOST,
  gitHead,
  recordingDecks,
  replayDecks,
  watchForModelRequests,
  type TrialDecks,
} from './cassette-deps.js';
import { runAndReport, type RunEnd } from './run-suite.js';
import { SpanCollector } from './span-records.js';

const logger = createLogger('eval');

/**
 * `yarn eval` — runs the suite and writes the three reports, or, when the run
 * cannot complete, `eval-abort.json` and an `eval-summary.md` that name why.
 * The replay tier in `agent-eval.yml` runs it on every pull request and the
 * live tier nightly; locally it is the same command.
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
async function main(): Promise<RunEnd> {
  loadEnvFile(resolve(process.cwd(), '..', '..'));

  // Resolved first and outside the body, so that everything after it — a typo
  // in the mode included — can be written down as an abort.
  const outputDir = resolve(process.env['EVAL_OUTPUT_DIR'] ?? 'eval-results');

  return runAndReport<MemoryOutcome>({
    outputDir,
    suite: MEMORY_RECALL_SUITE,
    explain: explainAbort,
    onAbort: (error, abort) =>
      logger.error({
        msg: 'eval.aborted',
        error: error instanceof Error ? error.message : String(error),
        cause: abort.cause?.code,
        completedTrials: abort.completedTrials.length,
        outputDir,
      }),
    body: async (progress, onTrial) => {
      const mode = readCassetteMode();
      const trials = Number(process.env['EVAL_TRIALS'] ?? 5);
      const axes = detectAxes();
      progress.axes = axes;

      // Before the watcher, the cassettes and the Nest context: a job on the
      // wrong axes must not reset a store or open a recording on its way to
      // failing.
      assertExpectedAxes(axes);

      const liveCalls =
        mode === 'replay'
          ? watchForModelRequests((target) =>
              logger.error({ msg: 'eval.replay.live-call', target }),
            )
          : () => [];
      const { suite, decks, replay } = prepare(mode, trials, axes);
      if (replay !== undefined) progress.replay = replay;

      // Before the Nest context, so every span the run opens reaches a
      // provider. Spans are kept in memory until the trial that produced them
      // asks for its trace; evaluation events are counted. Both also go over
      // OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set.
      const spans = new SpanCollector();
      const events = new InMemoryLogRecordExporter();
      initTelemetry({
        serviceName: 'agent-service',
        spanProcessors: [spans.processor],
        logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: events })],
      });

      const agent = await createAgentServiceHarness(decks, spans);

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
          onTrial: (trial) => {
            onTrial(trial);
            logger.info({
              msg: 'eval.trial',
              task: trial.taskId,
              trial: trial.index + 1,
              passed: trial.passed,
              failed: trial.results
                .filter((result) => result.score.label === 'fail')
                .map((result) => result.grader),
            });
          },
        }).run();

        // On the console as well as in the three files. A task that left the
        // run is the one thing a reader scanning stdout for the pass rate has
        // to see, and the rate is higher precisely because the task is missing
        // from it.
        for (const skipped of report.skipped) {
          logger.warn({
            msg: 'eval.task.skipped',
            task: skipped.taskId,
            problems: skipped.problems,
          });
        }

        // Before any report is written. A replayed suite that reached the
        // model is not a cheap suite that worked; it is an expensive one that
        // lied about which axis produced its number, and it must not leave a
        // report behind that says otherwise.
        const reached = liveCalls();
        if (reached.length > 0) {
          throw new Error(
            `replay made ${reached.length} request(s) to ${MODEL_HOST}: ${reached.join(', ')}`,
          );
        }

        // The same place, for the same reason. Content capture is off by an
        // allowlist, and a span that carried a key outside it is a report
        // that may have written content into `eval-report.json`.
        const unlisted = spans.unlistedKeys();
        if (unlisted.length > 0) {
          throw new Error(
            `a span carried attribute(s) outside ALLOWED_SPAN_ATTRIBUTES: ${unlisted.join(', ')}. ` +
              'Add a key to the list in @repo/telemetry only once it is known to carry no content.',
          );
        }

        logger.info({
          msg: 'eval.events',
          event: 'gen_ai.evaluation.result',
          emitted: events.getFinishedLogRecords().length,
          graderResults: report.tasks
            .flatMap((task) => task.trials)
            .reduce((sum, trial) => sum + trial.results.length, 0),
        });

        logger.info({
          msg: 'eval.done',
          axes: describeAxes(report.axes),
          passRate: report.passRate,
          tasksRun: report.tasks.length,
          tasksSkipped: report.skipped.map((skipped) => skipped.taskId),
          outputDir,
        });

        return report;
      } finally {
        await agent.close();
        // Flushes the OTLP export, when there is one.
        await shutdownTelemetry();
      }
    },
  });
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

main().then(
  (end) => {
    // An abort exits hard, as the fatal path always has: the run may have
    // stopped with a store connection or a Nest context half-open, and a
    // process that never exits is worse than one that exits 1.
    if (end === 'aborted') process.exit(1);
    if (end === 'failed') process.exitCode = 1;
  },
  (error: unknown) => {
    // Only reachable if writing the abort itself failed.
    logger.error({
      msg: 'eval.fatal',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  },
);
