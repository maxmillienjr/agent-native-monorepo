import type {
  Axes,
  AxisRequirement,
  AxisRequirements,
  Grader,
  SkippedTask,
  Task,
} from './types.js';

/**
 * What `EVAL_CASSETTE_MODE` was set to.
 *
 * `off` is the unset case and is not a synonym for "no cassettes exist": it
 * means this run neither records nor replays.
 */
export type CassetteMode = 'off' | 'record' | 'replay';

/**
 * Reads `EVAL_CASSETTE_MODE`, refusing anything that is not one of the two
 * modes.
 *
 * A typo is the failure worth spending a throw on. `EVAL_CASSETTE_MODE=relay`
 * read permissively would be `off`, which means a run that was asked to cost
 * nothing spends the whole free-tier quota instead — and says nothing, because
 * a live run is exactly what a live run looks like.
 */
export function readCassetteMode(env: NodeJS.ProcessEnv = process.env): CassetteMode {
  const raw = (env['EVAL_CASSETTE_MODE'] ?? '').trim();

  if (raw === '') return 'off';
  if (raw === 'record' || raw === 'replay') return raw;

  throw new Error(
    `EVAL_CASSETTE_MODE is \`${raw}\`, which is neither \`record\` nor \`replay\`. ` +
      'Refusing rather than reading it as unset: a run that was meant to replay and ' +
      'quietly went live spends the quota the mode exists to save.',
  );
}

/**
 * Reads the two axes from the environment, using exactly the variables the
 * service switches on.
 *
 * There is a second way to end up on a stub without noticing, and it is not
 * visible from here: Turbo runs in `envMode: strict`, so a task receives only
 * the variables its `env` array declares. A trial command run through Turbo
 * without `GOOGLE_API_KEY` in that array sees `undefined` and every trial
 * silently runs the canned model set — the suite reports on canned strings and
 * looks identical to one that is working. `turbo.json`'s `eval` task declares
 * it; `detectAxes` is what makes the consequence visible if it is ever dropped.
 *
 * `EVAL_CASSETTE_MODE` is the third variable, and only one of its two values is
 * an axis. `replay` *is* the model axis: the trial is served from a recorded
 * cassette and no model client is constructed. `record` is not — recording is a
 * live run that keeps a copy, so the axis stays whatever the key made it, which
 * is what puts `CassetteRecorder`'s refusal in reach when there is no key.
 */
export function detectAxes(env: NodeJS.ProcessEnv = process.env): Axes {
  const hasKey = (env['GOOGLE_API_KEY'] ?? '') !== '';
  const hasStores = (env['DATABASE_URL'] ?? '') !== '' && (env['NEO4J_URI'] ?? '') !== '';
  const replaying = readCassetteMode(env) === 'replay';

  return {
    model: replaying ? 'replay' : hasKey ? 'live' : 'stub',
    memory: hasStores ? 'live' : 'unconfigured',
  };
}

export function describeAxes(axes: Axes): string {
  return `model=${axes.model} memory=${axes.memory}`;
}

const accepted = <T>(requirement: AxisRequirement<T>): readonly T[] =>
  Array.isArray(requirement) ? requirement : [requirement as T];

/** `` `live` `` for a scalar, ``one of `live`, `replay` `` for a set. */
function describeRequirement<T>(requirement: AxisRequirement<T>): string {
  const values = accepted(requirement).map((value) => `\`${String(value)}\``);
  return values.length === 1 ? values[0]! : `one of ${values.join(', ')}`;
}

/**
 * Every axis the run does not satisfy, phrased so the reason survives on its
 * own: each problem names the axis the run is on *and* what was acceptable.
 * A skip recorded as "unmet requirement" and nothing else is unreviewable.
 */
export function unmetRequirements(requirements: AxisRequirements, axes: Axes): string[] {
  const problems: string[] = [];
  for (const axis of ['model', 'memory'] as const) {
    const requirement = requirements[axis];
    if (requirement === undefined) continue;
    if (accepted<string>(requirement).includes(axes[axis])) continue;
    problems.push(`${axis} axis is \`${axes[axis]}\`, needs ${describeRequirement(requirement)}`);
  }
  return problems;
}

/**
 * Thrown before any trial runs, never after.
 *
 * The alternative — running the grader anyway and letting it observe an empty
 * store — reports a pass on the no-op writers or a fail on an agent that did
 * nothing wrong. Both are worse than not running: a suite that grades a stub
 * without saying so is the failure P2-A shipped and had to be reopened for.
 */
export class AxisRequirementError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `eval refused to run: ${problems.length} grader requirement(s) are unmet.\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'AxisRequirementError';
  }
}

/** Collects every unmet requirement so one run reports all of them, not the first. */
export function assertAxesSatisfy(graders: readonly Grader<never>[], axes: Axes): void {
  const problems: string[] = [];

  for (const grader of graders) {
    if (!grader.requires) continue;
    for (const problem of unmetRequirements(grader.requires, axes)) {
      problems.push(`grader \`${grader.name}\`: ${problem}`);
    }
  }

  if (problems.length > 0) throw new AxisRequirementError(problems);
}

/**
 * The tasks this run cannot measure anything with, and why.
 *
 * A task is skipped where a grader refuses, and the asymmetry is deliberate. An
 * unmet grader requirement means the suite would report a number earned against
 * a no-op — there is no honest partial answer, so it refuses. An unmet task
 * requirement only means one scenario is not measurable here; refusing the whole
 * suite for it would make `yarn eval` unusable on a clone with no `.env`, which
 * is the ergonomics the quickstart depends on. The cost of skipping is that a
 * rate can quietly improve, which is why the skip is carried in the report and
 * printed by all three reporters rather than being left implicit.
 */
export function skippedTasks<TOutcome>(
  tasks: readonly Task<TOutcome>[],
  axes: Axes,
): SkippedTask[] {
  const skipped: SkippedTask[] = [];

  for (const task of tasks) {
    if (!task.requires) continue;
    const problems = unmetRequirements(task.requires, axes);
    if (problems.length > 0) skipped.push({ taskId: task.id, problems });
  }

  return skipped;
}
