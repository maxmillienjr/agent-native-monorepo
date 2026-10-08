import 'reflect-metadata';
import { resolve } from 'node:path';
import {
  EvalHarness,
  MEMORY_RECALL_DATASET_DIR,
  MEMORY_RECALL_SUITE,
  PRIOR_AUTH_DATASET_DIR,
  PRIOR_AUTH_SUITE,
  RED_TEAM_DATASET_DIR,
  RED_TEAM_SUITE,
  assertExpectedAxes,
  capTrialsToCassettes,
  describeAxes,
  detectAxes,
  gateBlocks,
  loadMemoryRecallSuite,
  loadPriorAuthSuite,
  loadRedTeamSuite,
  priorAuthFigures,
  readCassetteMode,
  readTaskFilter,
  selectTasks,
  skippedTasks,
  trialsFor,
  type AgentHarness,
  type Axes,
  type MemoryOutcome,
  type ModelIds,
  type PriorAuthOutcome,
  type ReplayProvenance,
  type Suite,
  type SuiteReport,
} from '@repo/eval-harness';
import { EMBEDDING_MODEL } from '@repo/memory-core';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { createLogger, initTelemetry, shutdownTelemetry } from '@repo/telemetry';
import { loadEnvFile } from '../load-env.js';
import { explainAbort } from './abort-cause.js';
import { createAgentServiceHarness } from './agent-harness.js';
import { createPriorAuthHarness } from './prior-auth-harness.js';
import {
  MODEL_HOST,
  gitHead,
  recordingDecks,
  replayDecks,
  watchForModelRequests,
  type TrialDecks,
} from './cassette-deps.js';
import {
  applyGate,
  assertGateAxes,
  assertGateModel,
  budgetBreachesIn,
  gatedEnd,
  readGateMode,
  type GateMode,
} from './gate.js';
import { CHAT_MODEL, PINNED_CHAT_MODEL } from '../runs/runs.service.js';
import { committedCassetteDigest } from './history.js';
import { GEMINI_PRICES } from './pricing.js';
import { runAndReport, type RunEnd } from './run-suite.js';
import { SpanCollector } from './span-records.js';

const logger = createLogger('eval');

/**
 * `yarn eval` — runs the suite and writes the three reports, or, when the run
 * cannot complete, `eval-abort.json` and an `eval-summary.md` that name why.
 * The replay tier in `agent-eval.yml` runs it on every pull request and the
 * live tier nightly; locally it is the same command. With `EVAL_GATE` set it
 * also writes `eval-gate.json`, and the gate's verdict — not whether every
 * trial passed — decides the exit code (`gate.ts`). A budget breach fails the
 * run either way: budgets sit beside the pass rate and beside the gate (P1-F).
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

  const name = readSuiteName(process.argv.slice(2), process.env);
  if (name === PRIOR_AUTH_SUITE) return runSuite(priorAuthSuite(), outputDir);
  if (name === MEMORY_RECALL_SUITE) return runSuite(memoryRecallSuite(), outputDir);
  if (name === RED_TEAM_SUITE) return runSuite(redTeamSuite(), outputDir);
  throw new Error(
    `unknown suite \`${name}\`: expected \`${MEMORY_RECALL_SUITE}\`, \`${RED_TEAM_SUITE}\` ` +
      `or \`${PRIOR_AUTH_SUITE}\``,
  );
}

/**
 * One evaluation suite, as the runner needs it: where its dataset lives, how
 * to load it, the adapter that runs it, and what it adds to the report.
 */
interface SuiteDefinition<TOutcome> {
  readonly name: string;
  readonly datasetDir: string;
  /**
   * Trials per task when `EVAL_TRIALS` is unset. One for prior-auth, whose
   * recording is one trial per task: at five, a live run of its 20 model
   * calls a trial would be 100, five times the free tier's daily quota.
   */
  readonly defaultTrials: number;
  load(trials: number): Suite<TOutcome>;
  harness(
    decks: TrialDecks | undefined,
    spans: SpanCollector,
  ): Promise<AgentHarness<TOutcome> & { close(): Promise<void> }>;
  finish(report: SuiteReport<TOutcome>): SuiteReport<TOutcome>;
}

function memoryRecallSuite(): SuiteDefinition<MemoryOutcome> {
  return {
    name: MEMORY_RECALL_SUITE,
    datasetDir: MEMORY_RECALL_DATASET_DIR,
    defaultTrials: 5,
    load: (trials) => loadMemoryRecallSuite(trials),
    harness: (decks, spans) => createAgentServiceHarness(decks, spans),
    finish: (report) => report,
  };
}

/**
 * The memory-poisoning red team (P4-B), on the memory-recall adapter.
 *
 * A suite of its own rather than three more files in memory-recall's
 * directory: its pass rate never shares a denominator with the capability
 * suite's, and it has its own cassettes and its own replay baseline. One
 * trial a task by default, because a live trial of the three is twelve
 * `generateContent` calls.
 */
function redTeamSuite(): SuiteDefinition<MemoryOutcome> {
  return {
    name: RED_TEAM_SUITE,
    datasetDir: RED_TEAM_DATASET_DIR,
    defaultTrials: 1,
    load: (trials) => loadRedTeamSuite(trials),
    harness: (decks, spans) => createAgentServiceHarness(decks, spans),
    finish: (report) => report,
  };
}

function priorAuthSuite(): SuiteDefinition<PriorAuthOutcome> {
  let labels: ReturnType<typeof loadPriorAuthSuite>['labels'] | undefined;
  return {
    name: PRIOR_AUTH_SUITE,
    datasetDir: PRIOR_AUTH_DATASET_DIR,
    defaultTrials: 1,
    load: (trials) => {
      const suite = loadPriorAuthSuite(trials);
      labels = suite.labels;
      return suite;
    },
    harness: (decks, spans) => createPriorAuthHarness(decks, spans),
    finish: (report) =>
      labels === undefined ? report : { ...report, figures: priorAuthFigures(report, labels) },
  };
}

/**
 * The suite to run: `--suite <name>` when the script is called directly, or
 * `EVAL_SUITE`, which is how `yarn eval` reaches it — Turbo reads a flag after
 * the task name as its own. Unset, it is memory-recall; the replay job runs
 * `red-team` as a second step.
 */
function readSuiteName(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const index = argv.indexOf('--suite');
  const fromFlag = index >= 0 ? argv[index + 1] : undefined;
  return fromFlag ?? env['EVAL_SUITE'] ?? MEMORY_RECALL_SUITE;
}

async function runSuite<TOutcome>(
  definition: SuiteDefinition<TOutcome>,
  outputDir: string,
): Promise<RunEnd> {
  const end = await runAndReport<TOutcome>({
    outputDir,
    suite: definition.name,
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
      const gate = readGateMode();
      const trials = Number(process.env['EVAL_TRIALS'] ?? definition.defaultTrials);
      const axes = detectAxes();
      progress.axes = axes;

      // Before the watcher, the cassettes and the Nest context: a job on the
      // wrong axes must not reset a store or open a recording on its way to
      // failing — and neither must a gate asked to judge an axis it cannot.
      assertExpectedAxes(axes);
      assertGateAxes(gate, axes);
      assertGateModel(gate, CHAT_MODEL, PINNED_CHAT_MODEL);

      const liveCalls =
        mode === 'replay'
          ? watchForModelRequests((target) =>
              logger.error({ msg: 'eval.replay.live-call', target }),
            )
          : () => [];
      const { suite, decks, replay, models } = prepare(definition, mode, trials, axes);
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

      const agent = await definition.harness(decks, spans);

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

        const report = await new EvalHarness<TOutcome>({
          agent,
          suite,
          ...(replay === undefined ? {} : { replay }),
          ...(models === undefined ? {} : { models }),
          prices: GEMINI_PRICES,
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
              withinBudget: trial.withinBudget,
            });
            for (const budget of trial.budgets) {
              if (budget.label === 'within') continue;
              logger.error({
                msg: 'eval.budget.breached',
                task: trial.taskId,
                trial: trial.index + 1,
                budget: budget.budget,
                limit: budget.limit,
                actual: budget.actual,
                label: budget.label,
              });
            }
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
          budgetBreaches: report.budgetBreaches,
          tasksRun: report.tasks.length,
          tasksSkipped: report.skipped.map((skipped) => skipped.taskId),
          outputDir,
        });

        return definition.finish(report);
      } finally {
        await agent.close();
        // Flushes the OTLP export, when there is one.
        await shutdownTelemetry();
      }
    },
  });

  return gateTheRun(end, outputDir, definition.datasetDir);
}

/**
 * With `EVAL_GATE` set, the gate's verdict decides the exit code in place of
 * "every trial passed" (P1-D).
 *
 * After `runAndReport` rather than inside it, because the gate reads the
 * output directory the way CI does — an abort file, or a report — and so
 * judges an aborted run by the same rule as a completed one.
 */
function gateTheRun(end: RunEnd, outputDir: string, datasetDir: string): RunEnd {
  let mode: GateMode | undefined;
  try {
    mode = readGateMode();
  } catch {
    // The body read it first and wrote the typo down as the abort.
    return end;
  }
  if (mode === undefined) return end;

  const historyDir = process.env['EVAL_HISTORY_DIR'];
  const result = applyGate({
    mode,
    outputDir,
    datasetDir,
    displayRoot: resolve(process.cwd(), '..', '..'),
    committedDigest: () => committedCassetteDigest(datasetDir),
    gitSha: () => gitHead().sha,
    ...(historyDir === undefined || historyDir === '' ? {} : { historyDir: resolve(historyDir) }),
  });

  const blocks = gateBlocks(result);
  const budgetBreaches = budgetBreachesIn(outputDir);
  (blocks || budgetBreaches > 0 ? logger.error : logger.info).call(logger, {
    msg: 'eval.gate',
    axis: result.axis,
    verdict: result.verdict,
    blocks,
    budgetBreaches,
    ...(result.verdict === 'aborted' ? { reason: result.reason } : {}),
    outputDir,
  });

  return gatedEnd(result, budgetBreaches);
}

/**
 * The suite, the decks and the provenance for one run, decided before the Nest
 * context is built.
 *
 * Before, because a replay against an incompatible or missing cassette set must
 * fail without having reset a database, and because the decorator has to be
 * installed on the service the moment the harness exists.
 */
function prepare<TOutcome>(
  definition: SuiteDefinition<TOutcome>,
  mode: 'off' | 'record' | 'replay',
  trials: number,
  axes: Axes,
): {
  suite: Suite<TOutcome>;
  decks: TrialDecks | undefined;
  replay: ReplayProvenance | undefined;
  models: ModelIds | undefined;
} {
  const suite = selectTasks(definition.load(trials), readTaskFilter());
  // The running configuration's ids, on the one axis that calls a model with
  // them. A replay names the ids its cassette headers recorded instead.
  const configured: ModelIds | undefined =
    axes.model === 'live' ? { chat: CHAT_MODEL, embedding: EMBEDDING_MODEL } : undefined;

  if (mode === 'off') return { suite, decks: undefined, replay: undefined, models: configured };

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
      decks: recordingDecks({ datasetDir: definition.datasetDir, axes, gitSha: head.sha }),
      replay: undefined,
      models: configured,
    };
  }

  // A task has as many replayable trials as it has cassettes, and a skipped
  // task needs none — it never runs.
  const capped = capTrialsToCassettes(suite, definition.datasetDir);
  const skipped = new Set(skippedTasks(capped.tasks, axes).map((task) => task.taskId));
  const decks = replayDecks(
    definition.datasetDir,
    capped.tasks
      .filter((task) => !skipped.has(task.id))
      .map((task) => ({ taskId: task.id, trials: trialsFor(task, capped) })),
  );

  return { suite: capped, decks, replay: decks.provenance(), models: decks.models() };
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
