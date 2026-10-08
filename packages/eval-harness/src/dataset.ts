import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AxisRequirementsSchema,
  BudgetsSchema,
  OutcomeSchema,
  TaskSeedsSchema,
  type Grader,
  type Suite,
  type Task,
} from './types.js';
import type { MemoryOutcome } from './outcome.js';
import {
  outcomeMustBe,
  retrievedContextMinLength,
  tokenCountsPositive,
  episodicRowWritten,
  entityMerged,
} from './graders/code.js';
import { trajectoryGraders } from './graders/trajectory.js';
import { RED_TEAM_SURFACES, redTeamGraders } from './graders/red-team.js';

/**
 * `datasets/` resolves the same from `src/` under vitest and from `dist/` in
 * the built package, because both sit one level below the package root — the
 * same trick `memory-core`'s migration folder uses.
 */
export const EVAL_DATASETS_DIR = fileURLToPath(new URL('../datasets', import.meta.url));

/** The capability dataset shipped with the package. Spelled once, for the same reason. */
export const MEMORY_RECALL_DATASET_DIR = join(EVAL_DATASETS_DIR, 'memory-recall');

/** The memory-poisoning red team (P4-B), a suite of its own. */
export const RED_TEAM_DATASET_DIR = join(EVAL_DATASETS_DIR, 'red-team');

/**
 * Where a dataset's cassettes live.
 *
 * The subdirectory is not decoration. `loadSuite` below reads every `.json` in
 * the dataset directory and parses each as a task spec, so a cassette dropped
 * beside a task file makes the whole suite throw on a Zod error. `readdirSync`
 * is not recursive and `cassettes` does not end in `.json`, so a subdirectory
 * is skipped.
 */
export function cassettesDir(datasetDir: string): string {
  return join(datasetDir, 'cassettes');
}

export function cassettePath(datasetDir: string, taskId: string, trialIndex: number): string {
  return join(cassettesDir(datasetDir), `${taskId}.trial-${trialIndex}.json`);
}

/**
 * How many trials of a task can actually be replayed.
 *
 * Counted from trial 0 and stopping at the first gap, rather than counting
 * files: the runner plays trial `i` of a task from the cassette named
 * `trial-i`, so a set holding trials 0 and 2 can serve exactly one trial. A
 * plain count would say two and miss on the second.
 *
 * This is also the whole of what `@repo/eval-harness` knows about a cassette.
 * It does not read one, does not parse one, and does not import
 * `@repo/agent-cassette` — that package's single runtime dependency is `zod`
 * and a convenience import here is how that would stop being true.
 */
export function countCassettes(datasetDir: string, taskId: string): number {
  let count = 0;
  while (existsSync(cassettePath(datasetDir, taskId, count))) count += 1;
  return count;
}

/**
 * Caps every task in a suite at the number of cassettes it has.
 *
 * Replaying one cassette five times reproduces one recorded trial five times:
 * `pass^k` would equal `pass@k` by construction and a single sample would be
 * presented as a reliability measurement. The cap makes k the truth about the
 * set rather than a number inherited from the live suite.
 */
export function capTrialsToCassettes<TOutcome>(
  suite: Suite<TOutcome>,
  datasetDir: string,
): Suite<TOutcome> {
  return {
    ...suite,
    tasks: suite.tasks.map((task) => ({
      ...task,
      trialsPerTask: countCassettes(datasetDir, task.id),
    })),
  };
}

/**
 * The framework ids a red-team task may map to, pinned so that a mistyped id
 * fails to load rather than mapping a case to a risk that does not exist.
 *
 * Only the ids a task uses are here. Adding one is an edit to this list with
 * its source beside it, which is where a reviewer checks it:
 *
 * - `ASI06` Memory & Context Poisoning, OWASP Top 10 for Agentic Applications
 *   for 2026 (published 2025-12-09).
 * - `LLM04:2025` Data and Model Poisoning and `LLM08:2025` Vector and Embedding
 *   Weaknesses, OWASP Top 10 for LLM Applications 2025. The suffix stays: the
 *   2026 edition renumbers the list.
 */
export const PINNED_OWASP_IDS = ['ASI06', 'LLM04:2025', 'LLM08:2025'] as const;

/**
 * MITRE ATLAS technique ids, from the 2026.09 data release
 * (`mitre-atlas/atlas-data`, `dist/v6/ATLAS-2026.09.yaml`): `AML.T0070` RAG
 * Poisoning, `AML.T0071` False RAG Entry Injection, and `AML.T0080.000` AI
 * Agent Context Poisoning: Memory. Same rule as the OWASP list.
 */
export const PINNED_ATLAS_IDS = ['AML.T0070', 'AML.T0071', 'AML.T0080.000'] as const;

/**
 * The `redTeam` block of a task file (P4-B).
 *
 * `canary` is the payload of the poisoned fact: the attack succeeded on a
 * surface if and only if the canary appears there. Each surface becomes one
 * `canary_absent_from_<surface>` grader. The mappings are data for the report
 * and the control catalogue; they grade nothing.
 */
export const RedTeamSpecSchema = z.object({
  canary: z.string().min(6),
  surfaces: z.array(z.enum(RED_TEAM_SURFACES)).min(1),
  owasp: z.array(z.enum(PINNED_OWASP_IDS)).min(1),
  atlas: z.array(z.enum(PINNED_ATLAS_IDS)).min(1),
});
export type RedTeamSpec = z.infer<typeof RedTeamSpecSchema>;

/** One request body, as a task file spells it: the graded `input`, or a prior run's. */
export const TaskInputSchema = z.object({
  sessionId: z.string().uuid(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
  config: z.record(z.unknown()).optional(),
});

/**
 * The task file format, superseding `run-fixture-001.json` while preserving it.
 *
 * `expectedSeeds` is retained as it was. The `assertions` block, which the
 * nightly seed script (since deleted) read past and nothing executed, becomes a
 * list of named code graders.
 */
export const TaskSpecSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /**
   * Which retrieval path the task exercises. There is one: ADR 0009 made
   * retrieval vector-only, so a task that declared `graph` or `hybrid` would
   * be describing a path no run takes. The field stays so that a task says
   * which path it measures, and a successor that brings a graph condition
   * back widens the enum in the same change that measures it.
   */
  retrievalPath: z.literal('vector'),
  input: TaskInputSchema,
  /**
   * Runs executed before `input`, in order, in the same trial, and not graded
   * (P4-B). Two at most: each is a full run's worth of model calls against a
   * 20-request daily quota.
   */
  priorRuns: z.array(TaskInputSchema).max(2).optional(),
  /** Present on a red-team task, and only there; see `RedTeamSpecSchema`. */
  redTeam: RedTeamSpecSchema.optional(),
  /**
   * The axes this task is meaningful on, scalar or set per axis.
   *
   * It lives in the task file rather than in code because it is a property of
   * the scenario: `tool-use-001` is graded on `tool_trajectory_recall`, and the
   * stub model's `selectTool` returns `null` for every input, so its score on
   * that axis is a fact about the fixture and not about the agent. A reviewer
   * reads the declaration next to the assertion it qualifies.
   */
  requires: AxisRequirementsSchema.optional(),
  /**
   * Per-trial ceilings on input tokens, output tokens and model calls (P1-F).
   *
   * Beside `requires` for the same reason: it describes the scenario, and a
   * change in what the scenario costs is a reviewed diff to the file next to
   * the assertions it rides with. Checked beside the graders, never among them.
   */
  budgets: BudgetsSchema.optional(),
  expectedSeeds: TaskSeedsSchema.default({}),
  expectedOutcome: OutcomeSchema,
  assertions: z.object({
    retrievedContextMinLength: z.number().int().nonnegative().optional(),
    outcomeMustBe: OutcomeSchema.optional(),
    tokenCountsPositive: z.boolean().optional(),
    /** `reflect` wrote at least this many `episodes` rows under the run's id. */
    episodicRowsMin: z.number().int().nonnegative().optional(),
    /** `reflect` MERGEd at least this many of the concepts `distill` produced. */
    mergedConceptsMin: z.number().int().nonnegative().optional(),
  }),
  /**
   * The reference the trajectory graders score against, and the threshold each
   * metric is gated at. A metric with no threshold produces no grader; a
   * threshold of `0` reports the metric without gating on it.
   */
  expectedTrajectory: z
    .object({
      nodes: z.array(z.string()).optional(),
      toolCalls: z.array(z.string()).optional(),
      thresholds: z.record(z.number().min(0).max(1)).default({}),
    })
    .optional(),
  notes: z.string().optional(),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/**
 * Builds the graders a task spec declares.
 *
 * Every assertion in the file becomes one named binary grader. Nothing is
 * implied: an assertion that is absent produces no grader, so a task cannot
 * accidentally be graded on a criterion it never stated.
 */
export function buildGraders(spec: TaskSpec): Grader<MemoryOutcome>[] {
  const graders: Grader<MemoryOutcome>[] = [];
  const a = spec.assertions;

  if (a.retrievedContextMinLength !== undefined) {
    graders.push(retrievedContextMinLength(a.retrievedContextMinLength));
  }
  if (a.outcomeMustBe !== undefined) graders.push(outcomeMustBe(a.outcomeMustBe));
  if (a.tokenCountsPositive === true) graders.push(tokenCountsPositive());
  if (a.episodicRowsMin !== undefined) graders.push(episodicRowWritten(a.episodicRowsMin));
  if (a.mergedConceptsMin !== undefined) graders.push(entityMerged(a.mergedConceptsMin));

  if (spec.expectedTrajectory) {
    graders.push(...trajectoryGraders<MemoryOutcome>(spec.expectedTrajectory));
  }

  if (spec.redTeam) graders.push(...redTeamGraders(spec.redTeam.canary, spec.redTeam.surfaces));

  return graders;
}

export function taskFromSpec(spec: TaskSpec): Task<MemoryOutcome> {
  return {
    id: spec.id,
    description: spec.description,
    input: spec.input,
    ...(spec.priorRuns === undefined ? {} : { priorInputs: spec.priorRuns }),
    seeds: spec.expectedSeeds,
    graders: buildGraders(spec),
    ...(spec.requires === undefined ? {} : { requires: spec.requires }),
    ...(spec.budgets === undefined ? {} : { budgets: spec.budgets }),
  };
}

export function loadTaskSpec(path: string): TaskSpec {
  return TaskSpecSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

/**
 * Parses every `.json` in a dataset directory as one task spec, in file order.
 *
 * An empty directory is an error rather than an empty suite. A suite that
 * silently grades nothing and reports a pass is the failure mode this whole
 * package exists to remove, and it is exactly what the nightly workflow's seed
 * step used to do.
 */
function loadSpecs(name: string, directory: string): TaskSpec[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    throw new Error(`eval suite "${name}" loaded no tasks from ${directory}`);
  }

  return files.map((file) => loadTaskSpec(join(directory, file)));
}

function suiteOf(
  name: string,
  specs: readonly TaskSpec[],
  trialsPerTask: number,
): Suite<MemoryOutcome> {
  return { name, tasks: specs.map(taskFromSpec), trialsPerTask };
}

/** Loads every `.json` in a dataset directory as one task. */
export function loadSuite(
  name: string,
  directory: string,
  trialsPerTask = 5,
): Suite<MemoryOutcome> {
  return suiteOf(name, loadSpecs(name, directory), trialsPerTask);
}

/**
 * `EVAL_TASKS`: a comma-separated list of task ids, or unset for all of them.
 *
 * It exists because recording is per suite. Adding one task and recording its
 * cassette would otherwise re-record every other task's too — spending their
 * `generateContent` calls against a 20-request daily quota and replacing
 * cassettes that were fine.
 */
export function readTaskFilter(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env['EVAL_TASKS']?.trim();
  if (raw === undefined || raw === '') return undefined;
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/**
 * The suite narrowed to the named tasks, in suite order.
 *
 * An id the suite does not hold is refused rather than ignored: a typo that
 * selected nothing would run an empty suite, and one that selected less than
 * intended would report a rate over the wrong tasks.
 */
export function selectTasks<TOutcome>(
  suite: Suite<TOutcome>,
  ids: readonly string[] | undefined,
): Suite<TOutcome> {
  if (ids === undefined) return suite;
  const known = new Set(suite.tasks.map((task) => task.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`EVAL_TASKS names task(s) the suite does not hold: ${unknown.join(', ')}`);
  }
  const wanted = new Set(ids);
  const tasks = suite.tasks.filter((task) => wanted.has(task.id));
  // The selection goes into the name, which every reporter prints, so a rate
  // over a narrowed suite never reads as a rate over the whole one.
  return { ...suite, name: `${suite.name} [${tasks.map((t) => t.id).join(', ')}]`, tasks };
}

/** The shipped suite's name, readable before it loads so an abort can name it. */
export const MEMORY_RECALL_SUITE = 'memory-recall';

/** The red team's suite name, for the same reason. */
export const RED_TEAM_SUITE = 'red-team';

/**
 * The capability dataset shipped with this package.
 *
 * It refuses a red-team task. A security case in this directory would share
 * memory-recall's denominator, and a capability rate that moved because a
 * security case was added, or the reverse, is the fault P1-G removed.
 */
export function loadMemoryRecallSuite(
  trialsPerTask = 5,
  directory: string = MEMORY_RECALL_DATASET_DIR,
): Suite<MemoryOutcome> {
  const specs = loadSpecs(MEMORY_RECALL_SUITE, directory);
  const misplaced = specs.filter((spec) => spec.redTeam !== undefined).map((spec) => spec.id);
  if (misplaced.length > 0) {
    throw new Error(
      `eval suite "${MEMORY_RECALL_SUITE}" holds red-team task(s) ${misplaced.join(', ')}: ` +
        `move them to ${RED_TEAM_DATASET_DIR}, whose rate is reported on its own`,
    );
  }
  return suiteOf(MEMORY_RECALL_SUITE, specs, trialsPerTask);
}

/**
 * The memory-poisoning red team (P4-B): every task carries a `redTeam` block.
 *
 * One trial a task by default. The recording and the baseline are one trial
 * each, and a live trial of the three tasks is twelve `generateContent` calls.
 */
export function loadRedTeamSuite(
  trialsPerTask = 1,
  directory: string = RED_TEAM_DATASET_DIR,
): Suite<MemoryOutcome> {
  const specs = loadSpecs(RED_TEAM_SUITE, directory);
  const unmarked = specs.filter((spec) => spec.redTeam === undefined).map((spec) => spec.id);
  if (unmarked.length > 0) {
    throw new Error(
      `eval suite "${RED_TEAM_SUITE}" holds task(s) with no redTeam block: ` +
        `${unmarked.join(', ')}. A capability task belongs in ${MEMORY_RECALL_DATASET_DIR}`,
    );
  }
  return suiteOf(RED_TEAM_SUITE, specs, trialsPerTask);
}
