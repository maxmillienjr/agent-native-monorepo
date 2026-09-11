import { assertAxesSatisfy, skippedTasks } from './axes.js';
import { ModelGrader } from './graders/model.js';
import type {
  AgentHarness,
  Axes,
  Grader,
  GraderResult,
  ReplayProvenance,
  Suite,
  SuiteReport,
  Task,
  TaskReport,
  Trial,
} from './types.js';

export interface EvalHarnessOptions<TOutcome> {
  readonly agent: AgentHarness<TOutcome>;
  readonly suite: Suite<TOutcome>;
  /** Called once per finished trial. The runner writes no output of its own. */
  readonly onTrial?: (trial: Trial<TOutcome>) => void;
  /**
   * Which recording is serving this run, on the `replay` axis.
   *
   * It arrives as data rather than through `AgentHarness` because the cassette
   * set is a set of files the caller already had to open to wire the replay up,
   * and adding a method to the adapter interface for a value it would only pass
   * through is a change every implementor pays for.
   */
  readonly replay?: ReplayProvenance;
}

async function runGraders<TOutcome>(
  graders: readonly Grader<TOutcome>[],
  trial: Pick<Trial<TOutcome>, 'transcript' | 'outcome'>,
): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  for (const grader of graders) {
    const score = await grader.grade(trial.transcript, trial.outcome);
    if (grader.kind === 'model' && (score.explanation ?? '').trim() === '') {
      throw new Error(`model grader \`${grader.name}\` returned a score with no explanation`);
    }
    results.push({ grader: grader.name, kind: grader.kind, score });
  }
  return results;
}

/**
 * How many trials this task gets: the suite's figure, or the task's own where
 * it asked for fewer.
 *
 * Only downwards. A task that could raise the suite's k would let one file
 * decide what the whole run costs, and the reason a task carries the field at
 * all is a shortage — of cassettes — rather than an appetite.
 */
export function trialsFor<TOutcome>(task: Task<TOutcome>, suite: Suite<TOutcome>): number {
  const capped = Math.min(suite.trialsPerTask, task.trialsPerTask ?? suite.trialsPerTask);
  return Math.max(0, capped);
}

function summarize<TOutcome>(
  task: Task<TOutcome>,
  trialsPerTask: number,
  trials: readonly Trial<TOutcome>[],
): TaskReport<TOutcome> {
  const perGraderPassRate: Record<string, number> = {};

  for (const grader of task.graders) {
    const passes = trials.filter((trial) =>
      trial.results.some((r) => r.grader === grader.name && r.score.label === 'pass'),
    ).length;
    perGraderPassRate[grader.name] = trials.length === 0 ? 0 : passes / trials.length;
  }

  return {
    taskId: task.id,
    description: task.description,
    trials,
    trialsPerTask,
    // Capability: at least one of k trials passed.
    passAtK: trials.some((trial) => trial.passed),
    // Reliability: all k passed. It decays as p^k, which is the point — it is
    // the gap between "can do this" and "does this dependably", and it is the
    // number that matters for anything that touches memory writes.
    passHatK: trials.length > 0 && trials.every((trial) => trial.passed),
    perGraderPassRate,
  };
}

/**
 * Loads tasks, resets the environment, runs n trials, aggregates.
 *
 * The order inside a trial is fixed and is not the task author's to choose:
 * reset, run, capture, grade. Reset before rather than after, so a suite that
 * crashes leaves the evidence of the failed trial in the stores.
 */
export class EvalHarness<TOutcome> {
  constructor(private readonly options: EvalHarnessOptions<TOutcome>) {}

  async run(): Promise<SuiteReport<TOutcome>> {
    const { agent, suite } = this.options;
    const axes = agent.axes();
    assertReplayProvenance(axes, this.options.replay);
    const startedAt = new Date().toISOString();

    // Which tasks this run cannot measure anything with. Unlike the grader
    // check below it does not throw: the tasks it names are dropped from the
    // run and travel to every reporter as `skipped`.
    const skipped = skippedTasks(suite.tasks, axes);
    const skippedIds = new Set(skipped.map((entry) => entry.taskId));
    const running = suite.tasks.filter((task) => !skippedIds.has(task.id));

    // Before any trial, so an unmeetable requirement costs no model calls and
    // no database writes. Every unmet requirement is reported, not the first.
    //
    // Over the tasks that will run, not over every task: a grader belonging to
    // a skipped task never grades anything, and refusing the suite on its
    // behalf would let one task's declared requirement take the whole run down
    // with it — the ergonomics the skip exists to protect.
    for (const task of running) {
      assertAxesSatisfy(task.graders as readonly Grader<never>[], axes);
    }

    const taskReports: TaskReport<TOutcome>[] = [];

    for (const task of running) {
      const trials: Trial<TOutcome>[] = [];
      const trialsPerTask = trialsFor(task, suite);

      for (let index = 0; index < trialsPerTask; index++) {
        await agent.reset(task);
        const transcript = await agent.run(task);
        const outcome = await agent.captureOutcome(task, transcript);
        const results = await runGraders(task.graders, { transcript, outcome });

        const trial: Trial<TOutcome> = {
          taskId: task.id,
          index,
          transcript,
          outcome,
          results,
          passed: results.every((result) => result.score.label === 'pass'),
        };

        trials.push(trial);
        this.options.onTrial?.(trial);
      }

      taskReports.push(summarize(task, trialsPerTask, trials));
    }

    // Only the tasks that ran contribute trials, so the rate is already over
    // the tasks that ran. That is the half of the change that flatters: on the
    // stub axis it turns a misleading 50% into a 100% that is true of a smaller
    // question. `skipped` below is what keeps the smaller question visible.
    const allTrials = taskReports.flatMap((report) => report.trials);

    return {
      suite: suite.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      axes,
      trialsPerTask: suite.trialsPerTask,
      ...(this.options.replay === undefined ? {} : { replay: this.options.replay }),
      tasks: taskReports,
      passRate:
        allTrials.length === 0
          ? 0
          : allTrials.filter((trial) => trial.passed).length / allTrials.length,
      skipped,
      uncalibratedGraders: uncalibrated(running),
    };
  }
}

/**
 * The two halves of "a replayed number says which recording produced it".
 *
 * Both directions are refused before a trial runs. A `replay` axis with no
 * provenance publishes a frozen sample with nothing to date it against, and a
 * provenance block on a run that was not replaying attributes a live number to
 * a cassette set — the second is the worse of the two, and the cheaper to write
 * by accident.
 */
function assertReplayProvenance(axes: Axes, replay: ReplayProvenance | undefined): void {
  if (axes.model === 'replay' && replay === undefined) {
    throw new Error(
      'the model axis is `replay` and no cassette provenance was given: a replayed ' +
        'rate has to name the set it came out of, or it cannot be told from a live one',
    );
  }
  if (axes.model !== 'replay' && replay !== undefined) {
    throw new Error(
      `cassette provenance was given on model axis \`${axes.model}\`: a number this run ` +
        'earned would be attributed to a recording that did not produce it',
    );
  }
}

/**
 * A judge with no calibration set has an unmeasured true-positive and
 * true-negative rate, and reporting its verdicts without saying so presents a
 * guess as a measurement.
 */
function uncalibrated<TOutcome>(tasks: readonly Task<TOutcome>[]): string[] {
  const names = new Set<string>();
  for (const task of tasks) {
    for (const grader of task.graders) {
      if (grader instanceof ModelGrader && grader.calibrationReport === undefined) {
        names.add(grader.name);
      }
    }
  }
  return [...names].sort();
}
