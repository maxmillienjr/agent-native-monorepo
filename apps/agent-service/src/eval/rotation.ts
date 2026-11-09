import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CassetteSchema, type Cassette, type Seam } from '@repo/agent-cassette';
import {
  PRIOR_AUTH_DATASET_DIR,
  RED_TEAM_DATASET_DIR,
  digestFiles,
  loadMemoryRecallSuite,
  loadPriorAuthSuite,
  loadRedTeamSuite,
  type Budgets,
  type LiveTally,
} from '@repo/eval-harness';
import { committedCassettes, readEpoch } from './history.js';

/**
 * The nightly rotation (P1-H): which prior-auth and red-team tasks run on the
 * live model tonight, on what the free key's day has left.
 *
 * Everything here is a function of files: the `eval-history` checkout, the
 * cassettes committed at `HEAD`, the night's `eval-live` artifact and the
 * recorded daily limit. Anyone with the history commit and `HEAD` can
 * recompute any night's slice. A night that was skipped, paused or aborted
 * pushed no tally, so the next night's coverage is unchanged and it picks the
 * same tasks again: the rotation resumes by construction, not by a counter.
 */

export const ROTATION_SUITES = ['prior-auth', 'red-team'] as const;
export type RotationSuite = (typeof ROTATION_SUITES)[number];

export interface RotationTask {
  readonly suite: RotationSuite;
  readonly id: string;
  /** `generateContent` requests one trial makes. */
  readonly cost: number;
  /** Trials the task has in its suite's current epoch on `eval-history`. */
  readonly trials: number;
}

export interface Slice {
  readonly tasks: Record<RotationSuite, string[]>;
  readonly calls: number;
  readonly skipped: { readonly id: string; readonly cost: number }[];
}

/**
 * Fewest trials first, then suite order, then task order; take each task that
 * still fits.
 *
 * `tasks` lists each suite's tasks in its file order, which is the order the
 * loaders read them in. A task whose cost is more than what is left is skipped,
 * not taken, and the walk goes on, so a cheaper task behind it can still fit.
 * Zero-cost tasks always fit. A slice with no task that makes a model call is
 * returned empty: measuring only the administrative tasks would be live in
 * name only.
 */
export function selectSlice(tasks: readonly RotationTask[], budget: number): Slice {
  const suiteRank = (suite: RotationSuite): number => ROTATION_SUITES.indexOf(suite);
  const order = tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (a, b) =>
        a.task.trials - b.task.trials ||
        suiteRank(a.task.suite) - suiteRank(b.task.suite) ||
        a.index - b.index,
    );

  let left = budget;
  const taken: { task: RotationTask; index: number }[] = [];
  const skipped: { id: string; cost: number }[] = [];
  for (const entry of order) {
    if (entry.task.cost <= left) {
      taken.push(entry);
      left -= entry.task.cost;
    } else {
      skipped.push({ id: entry.task.id, cost: entry.task.cost });
    }
  }

  const empty = { 'prior-auth': [], 'red-team': [] };
  if (!taken.some(({ task }) => task.cost > 0)) return { tasks: empty, calls: 0, skipped };

  const inFileOrder = [...taken].sort((a, b) => a.index - b.index);
  return {
    tasks: {
      'prior-auth': inFileOrder.filter(({ task }) => task.suite === 'prior-auth').map(idOf),
      'red-team': inFileOrder.filter(({ task }) => task.suite === 'red-team').map(idOf),
    },
    calls: taken.reduce((sum, { task }) => sum + task.cost, 0),
    skipped,
  };
}

const idOf = ({ task }: { task: RotationTask }): string => task.id;

// --- What a task costs, and how covered it is ---------------------------------

/**
 * The seams that are `generateContent` requests. `embed` is `embedContent`, on
 * a quota of its own, and `act.tool` and `act.compensate` are tool effects.
 */
export const GENERATE_CONTENT_SEAMS: readonly Seam[] = [
  'plan.callLlm',
  'act.selectTool',
  'distill.extractEntities',
  'assess.criteria',
];

export function generateContentCalls(cassette: Cassette): number {
  return cassette.decisions.filter((decision) => GENERATE_CONTENT_SEAMS.includes(decision.seam))
    .length;
}

/**
 * A task's cost: its `budgets.modelCalls` when it declares one, which covers the
 * red-team and memory-recall tasks, and otherwise the `generateContent` seams in
 * its committed cassettes, the most any trial made. That is 1 for a prior-auth
 * task and 0 for an administrative one, whose cassette holds no decision.
 */
export function taskCost(
  task: { readonly id: string; readonly budgets?: Budgets },
  cassettes: readonly Cassette[],
): number {
  const ceiling = task.budgets?.modelCalls;
  if (ceiling !== undefined) return ceiling;
  const own = cassettes.filter((cassette) => cassette.header.taskId === task.id);
  if (own.length === 0) {
    throw new Error(
      `task ${task.id} declares no budgets.modelCalls and has no committed cassette to cost it ` +
        'from; record it, or give it a budget, before the rotation can run it',
    );
  }
  return Math.max(...own.map(generateContentCalls));
}

/** Trials per task over one epoch's tallies. */
export function coverage(tallies: readonly LiveTally[]): Record<string, number> {
  const trials: Record<string, number> = {};
  for (const tally of tallies) {
    for (const [task, { trials: run }] of Object.entries(tally.tasks)) {
      trials[task] = (trials[task] ?? 0) + run.length;
    }
  }
  return trials;
}

/**
 * Both suites' tasks, costed from the cassettes committed at `HEAD` and covered
 * from the epoch those cassettes name. A re-record changes the digest, so the
 * epoch is new, every task's coverage is zero and the walk starts again from
 * the first task.
 */
export function rotationTasks(historyDir: string): RotationTask[] {
  const suites: { suite: RotationSuite; datasetDir: string; tasks: readonly SuiteTask[] }[] = [
    { suite: 'prior-auth', datasetDir: PRIOR_AUTH_DATASET_DIR, tasks: loadPriorAuthSuite(1).tasks },
    { suite: 'red-team', datasetDir: RED_TEAM_DATASET_DIR, tasks: loadRedTeamSuite(1).tasks },
  ];
  return suites.flatMap(({ suite, datasetDir, tasks }) => {
    const files = committedCassettes(datasetDir);
    const cassettes = files.map((file) =>
      CassetteSchema.parse(JSON.parse(Buffer.from(file.bytes).toString('utf8'))),
    );
    const covered = coverage(readEpoch(historyDir, suite, digestFiles(files)));
    return tasks.map((task) => ({
      suite,
      id: task.id,
      cost: taskCost(task, cassettes),
      trials: covered[task.id] ?? 0,
    }));
  });
}

interface SuiteTask {
  readonly id: string;
  readonly budgets?: Budgets;
}

// --- What the night has left -------------------------------------------------

/**
 * `R`: one provider-5xx retry inside the slice. `yarn eval` retries a 5xx once
 * on the live axis and then aborts (P1-I), so a slice can make at most one
 * request more than its cost before it stops.
 */
export const ROTATION_RESERVE = 1;

/** What `eval-live` and the canary spent tonight, as far as their files say. */
export type NightSpend =
  | {
      /** `measured` from the report; `ceiling` when there is none to measure from. */
      readonly kind: 'measured' | 'ceiling';
      readonly live: number;
      readonly canary: number;
      readonly source: string;
    }
  | { readonly kind: 'exhausted'; readonly source: string };

const LiveReportUsageSchema = z.object({
  usage: z.object({ trials: z.array(z.object({ modelCalls: z.number().int().nonnegative() })) }),
});
const AbortCauseSchema = z.object({ cause: z.object({ code: z.string() }).optional() });

/**
 * `S`, read from the downloaded `eval-live` artifact and the canary job's
 * result.
 *
 * - A report: Σ `usage.trials[].modelCalls`, which counts every
 *   `generate_content` span, errored ones included.
 * - An abort naming the per-day quota: nothing is left today.
 * - Any other abort, or no file at all: `liveCeiling`, memory-recall's
 *   `modelCalls` ceilings, because the trials that ran are not in a report.
 *
 * The canary spends one call on the pinned id whenever its job ran; a job that
 * failed or was cancelled may still have made it.
 */
export function readNightSpend(options: {
  readonly liveDir: string;
  readonly canaryResult: string | undefined;
  readonly liveCeiling: () => number;
}): NightSpend {
  const canary = options.canaryResult === 'skipped' ? 0 : 1;
  const abortPath = resolve(options.liveDir, 'eval-abort.json');
  if (existsSync(abortPath)) {
    const abort = AbortCauseSchema.safeParse(JSON.parse(readFileSync(abortPath, 'utf8')));
    const code = abort.success ? abort.data.cause?.code : undefined;
    if (code === 'daily-quota') {
      return { kind: 'exhausted', source: '`eval-live` aborted on the per-day quota' };
    }
    return {
      kind: 'ceiling',
      live: options.liveCeiling(),
      canary,
      source: `\`eval-live\` aborted${code === undefined ? '' : ` (\`${code}\`)`}; its ceilings`,
    };
  }
  const reportPath = resolve(options.liveDir, 'eval-report.json');
  if (!existsSync(reportPath)) {
    return {
      kind: 'ceiling',
      live: options.liveCeiling(),
      canary,
      source: '`eval-live` left no report; its ceilings',
    };
  }
  const report = LiveReportUsageSchema.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
  return {
    kind: 'measured',
    live: report.usage.trials.reduce((sum, trial) => sum + trial.modelCalls, 0),
    canary,
    source: "`eval-live`'s report",
  };
}

/** Memory-recall's `modelCalls` ceilings for `trials` trials a task: 17 at one trial. */
export function memoryRecallCeiling(trials: number): number {
  return loadMemoryRecallSuite(1).tasks.reduce((sum, task) => sum + trials * taskCost(task, []), 0);
}

/**
 * `EVAL_ROTATION_DAILY_LIMIT`: the free tier's `generateContent` requests per
 * day for the pinned id on the secret's project. Empty means nobody has read
 * and recorded it, and the rotation runs nothing rather than guess.
 */
export function readDailyLimit(raw: string | undefined): number | undefined {
  const value = raw?.trim() ?? '';
  if (value === '') return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `EVAL_ROTATION_DAILY_LIMIT must be a whole number of requests; got \`${value}\``,
    );
  }
  return Number(value);
}

/** `budget = L − S − R`, and never below zero. */
export function rotationBudget(
  limit: number,
  spend: NightSpend,
): { readonly spent: number | undefined; readonly budget: number } {
  if (spend.kind === 'exhausted') return { spent: undefined, budget: 0 };
  const spent = spend.live + spend.canary;
  return { spent, budget: Math.max(0, limit - spent - ROTATION_RESERVE) };
}

// --- The plan, and what it writes -------------------------------------------

export type RotationPlan =
  | { readonly status: 'not-recorded' }
  | {
      readonly status: 'run' | 'nothing-fits';
      readonly limit: number;
      readonly spend: NightSpend;
      readonly spent: number | undefined;
      readonly budget: number;
      readonly tasks: readonly RotationTask[];
      readonly slice: Slice;
    };

/**
 * Tonight's plan. The two readers are lazy: with no recorded limit nothing is
 * read at all, not the artifact and not the history.
 */
export function planRotation(inputs: {
  readonly limit: string | undefined;
  readonly spend: () => NightSpend;
  readonly tasks: () => readonly RotationTask[];
}): RotationPlan {
  const limit = readDailyLimit(inputs.limit);
  if (limit === undefined) return { status: 'not-recorded' };
  const spend = inputs.spend();
  const { spent, budget } = rotationBudget(limit, spend);
  const tasks = inputs.tasks();
  const slice = selectSlice(tasks, budget);
  return {
    status: slice.calls > 0 ? 'run' : 'nothing-fits',
    limit,
    spend,
    spent,
    budget,
    tasks,
    slice,
  };
}

/** The lines the workflow reads from `$GITHUB_OUTPUT`. */
export function githubOutputLines(plan: RotationPlan): string[] {
  const slice = plan.status === 'run' ? plan.slice : undefined;
  return [
    `run=${slice === undefined ? 'false' : 'true'}`,
    `prior_auth=${slice?.tasks['prior-auth'].join(',') ?? ''}`,
    `red_team=${slice?.tasks['red-team'].join(',') ?? ''}`,
    `budget=${plan.status === 'not-recorded' ? '' : String(plan.budget)}`,
    `calls=${slice?.calls ?? 0}`,
  ];
}

export const NOT_RECORDED_HEADING = 'Rotation — not run: the free-tier limit is not recorded';

/** `rotation-summary.md`: what the job summary prints above the two suites' own. */
export function renderRotationSummary(plan: RotationPlan): string {
  if (plan.status === 'not-recorded') {
    return [
      `## ${NOT_RECORDED_HEADING}`,
      '',
      '`EVAL_ROTATION_DAILY_LIMIT` is empty in `agent-eval.yml`, so the slice has no budget and ' +
        'no `yarn eval` ran. It does not fall back to a guessed number. Record the free-tier ' +
        '`generateContent` requests per day for the pinned chat id on the secret’s project, ' +
        'with its source, in `.context/conventions.md` ("Live model quota") and in the ' +
        'workflow (P1-H, criterion 1). No tally was pushed.',
      '',
    ].join('\n');
  }

  const spend = plan.spend;
  const s =
    spend.kind === 'exhausted'
      ? `— (${spend.source})`
      : `${plan.spent} (${spend.live} from ${spend.source}, ${spend.canary} for \`eval-canary\`)`;
  const lines = [
    plan.status === 'run'
      ? `## Rotation — ${plan.slice.calls} of ${plan.budget} calls on the live model`
      : '## Rotation — not run: no task with a model call fits tonight’s budget',
    '',
    '| `L` (recorded limit) | `S` (spent tonight) | `R` (reserve) | Budget `L − S − R` |',
    '| -------------------- | ------------------- | ------------- | ------------------ |',
    `| ${plan.limit} | ${s} | ${ROTATION_RESERVE} | ${plan.budget} |`,
  ];

  if (plan.status === 'run') {
    const byId = new Map(plan.tasks.map((task) => [`${task.suite}/${task.id}`, task]));
    lines.push(
      '',
      '| Suite | Task | Calls | Trials in epoch before tonight |',
      '| ----- | ---- | ----- | ------------------------------ |',
      ...ROTATION_SUITES.flatMap((suite) =>
        plan.slice.tasks[suite].map((id) => {
          const task = byId.get(`${suite}/${id}`);
          return `| ${suite} | \`${id}\` | ${task?.cost ?? '?'} | ${task?.trials ?? '?'} |`;
        }),
      ),
    );
  } else {
    lines.push(
      '',
      'No `yarn eval` ran and no tally was pushed. Measuring only the zero-cost administrative ' +
        'tasks would be live in name only.',
    );
  }

  // The least-covered tasks that were left out, so a task that keeps missing
  // its turn shows every night it does.
  const left = new Set(plan.slice.skipped.map((task) => task.id));
  const skipped = plan.tasks.filter((task) => left.has(task.id));
  const fewest = Math.min(...skipped.map((task) => task.trials));
  const behind = skipped.filter((task) => task.trials === fewest);
  if (behind.length > 0) {
    lines.push(
      '',
      `**Did not fit tonight** (${fewest} trial(s) in the epoch): ` +
        behind.map((task) => `\`${task.id}\` (${task.cost})`).join(', ') +
        '.',
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * `yarn workspace @repo/agent-service eval:history slice`, for the rotation
 * job in `agent-eval.yml`.
 *
 *   EVAL_ROTATION_DAILY_LIMIT  `L`; empty runs nothing
 *   EVAL_HISTORY_DIR           the `eval-history` checkout, for coverage
 *   ROTATION_LIVE_DIR          the downloaded `eval-live` artifact
 *   ROTATION_CANARY_RESULT     `needs.canary.result`
 *   ROTATION_LIVE_TRIALS       `eval-live`'s trials per task (default 1)
 *   ROTATION_OUTPUT_DIR        where `rotation-summary.md` and `rotation.json` go
 *   GITHUB_OUTPUT              appended with `run`, `prior_auth`, `red_team`,
 *                              `budget` and `calls`
 */
export function runSlice(
  env: NodeJS.ProcessEnv = process.env,
  readers: {
    readonly tasks?: (historyDir: string) => readonly RotationTask[];
    readonly liveCeiling?: (trials: number) => number;
  } = {},
): RotationPlan {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set`);
    return value;
  };
  const plan = planRotation({
    limit: env['EVAL_ROTATION_DAILY_LIMIT'],
    spend: () =>
      readNightSpend({
        liveDir: resolve(required('ROTATION_LIVE_DIR')),
        canaryResult: env['ROTATION_CANARY_RESULT'],
        liveCeiling: () =>
          (readers.liveCeiling ?? memoryRecallCeiling)(Number(env['ROTATION_LIVE_TRIALS'] || 1)),
      }),
    tasks: () => (readers.tasks ?? rotationTasks)(resolve(required('EVAL_HISTORY_DIR'))),
  });

  const outputDir = resolve(env['ROTATION_OUTPUT_DIR'] ?? 'rotation-results');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, 'rotation-summary.md'), renderRotationSummary(plan));
  writeFileSync(resolve(outputDir, 'rotation.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const githubOutput = env['GITHUB_OUTPUT'];
  if (githubOutput !== undefined && githubOutput !== '') {
    appendFileSync(githubOutput, `${githubOutputLines(plan).join('\n')}\n`);
  }
  return plan;
}
