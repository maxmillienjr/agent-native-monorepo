import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AxisRequirementsSchema,
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

/**
 * `datasets/` resolves the same from `src/` under vitest and from `dist/` in
 * the built package, because both sit one level below the package root — the
 * same trick `memory-core`'s migration folder uses.
 */
export const EVAL_DATASETS_DIR = fileURLToPath(new URL('../datasets', import.meta.url));

/** The one dataset shipped with the package. Spelled once, for the same reason. */
export const MEMORY_RECALL_DATASET_DIR = join(EVAL_DATASETS_DIR, 'memory-recall');

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
 * The task file format, superseding `run-fixture-001.json` while preserving it.
 *
 * `expectedSeeds` is retained as it was. The `assertions` block, which
 * `scripts/seed-eval-fixtures.mjs` read past and nothing executed, becomes a
 * list of named code graders.
 */
export const TaskSpecSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /**
   * Which retrieval path the seeded state actually exercises. Not decoration:
   * `expandFromSeeds` returns `:Fact` nodes reached through `MENTIONS`, and a
   * seed set of `:Concept` nodes and `RELATES_TO` edges has none, so the graph
   * retriever returns nothing for such a task regardless of the query.
   */
  retrievalPath: z.enum(['vector', 'graph', 'hybrid']),
  input: z.object({
    sessionId: z.string().uuid(),
    messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
    config: z.record(z.unknown()).optional(),
  }),
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
  expectedSeeds: TaskSeedsSchema.default({ neo4j: [], relationships: [], pgvector: [] }),
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

  return graders;
}

export function taskFromSpec(spec: TaskSpec): Task<MemoryOutcome> {
  return {
    id: spec.id,
    description: spec.description,
    input: spec.input,
    seeds: spec.expectedSeeds,
    graders: buildGraders(spec),
    ...(spec.requires === undefined ? {} : { requires: spec.requires }),
  };
}

export function loadTaskSpec(path: string): TaskSpec {
  return TaskSpecSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

/**
 * Loads every `.json` in a dataset directory as one task.
 *
 * An empty directory is an error rather than an empty suite. A suite that
 * silently grades nothing and reports a pass is the failure mode this whole
 * package exists to remove, and it is exactly what the nightly workflow's seed
 * step used to do.
 */
export function loadSuite(
  name: string,
  directory: string,
  trialsPerTask = 5,
): Suite<MemoryOutcome> {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    throw new Error(`eval suite "${name}" loaded no tasks from ${directory}`);
  }

  return {
    name,
    tasks: files.map((file) => taskFromSpec(loadTaskSpec(join(directory, file)))),
    trialsPerTask,
  };
}

/** The dataset shipped with this package. */
export function loadMemoryRecallSuite(trialsPerTask = 5): Suite<MemoryOutcome> {
  return loadSuite('memory-recall', MEMORY_RECALL_DATASET_DIR, trialsPerTask);
}
