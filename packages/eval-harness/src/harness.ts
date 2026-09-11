import { assertAxesSatisfy, skippedTasks } from './axes.js';
import { ModelGrader } from './graders/model.js';
import type {
  AgentHarness,
  Grader,
  GraderResult,
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

function summarize<TOutcome>(
  task: Task<TOutcome>,
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

      for (let index = 0; index < suite.trialsPerTask; index++) {
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

      taskReports.push(summarize(task, trials));
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
