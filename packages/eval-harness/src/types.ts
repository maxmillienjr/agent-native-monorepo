import { z } from 'zod';
import { OutcomeSchema, type Message } from '@repo/shared-types';

/**
 * The vocabulary. These names follow published agent-evaluation practice so the
 * package reads as familiar rather than bespoke:
 *
 * - `Task`       one evaluable scenario: input, seed state, graders
 * - `Trial`      one execution of a task; agents are stochastic, so tasks run n
 * - `Transcript` the record of a trial: messages, node sequence, tool calls
 * - `Outcome`    the environment state *after* the trial
 * - `Grader`     (transcript, outcome) => Score
 * - `Suite`      a named collection of tasks with shared configuration
 */

// --- Axes ------------------------------------------------------------------

/**
 * A trial can be run against a stub on either of two independent axes, and on
 * both of them the stub passes assertions the real system fails.
 *
 * `RunsService` picks live Gemini dependencies when `GOOGLE_API_KEY` is set and
 * a canned stub set otherwise; `MemoryModule` resolves every adapter to `null`
 * when `DATABASE_URL` and `NEO4J_URI` are absent, and `RunsService` substitutes
 * no-op writers. Both stub paths are load-bearing — a clone with no `.env` has
 * to serve the quickstart curls — so the harness cannot remove them. What it
 * can do is refuse to report a number earned against them.
 */
/**
 * `replay` is vocabulary, and nothing produces it yet.
 *
 * A replayed trial is served from a recorded cassette by
 * `@repo/agent-cassette`, and it is a third value rather than a disguise for
 * `live` because a replayed `pass^k` is a frozen sample: it reproduces the
 * recorded run exactly, catches a change in the graph, the prompts' effect on
 * branching, the memory writes and the graders, and cannot catch the model
 * getting worse or the client breaking.
 *
 * `detectAxes` does not return it and will not until P1-B's wiring lands. A
 * producer that ran ahead of the wiring would label a live run as replayed,
 * which is the class of quiet lie the axes exist to prevent.
 */
export const ModelAxisSchema = z.enum(['live', 'stub', 'replay']);
export type ModelAxis = z.infer<typeof ModelAxisSchema>;

export const MemoryAxisSchema = z.enum(['live', 'unconfigured']);
export type MemoryAxis = z.infer<typeof MemoryAxisSchema>;

export interface Axes {
  readonly model: ModelAxis;
  readonly memory: MemoryAxis;
}

/**
 * One axis' worth of requirement: a single value, or a set of acceptable ones.
 *
 * The set is not decoration. A task that needs "an axis that can select a tool"
 * is satisfied by `live` and by `replay`, and pinning it to `live` would refuse
 * it on exactly the axis P1-B exists to make affordable. A scalar stays legal
 * and means the same thing it did, so every grader declaring one is unchanged.
 */
export type AxisRequirement<T> = T | readonly T[];

/** What a grader needs to be meaningful. Unmet requirements stop the suite. */
export interface AxisRequirements {
  readonly model?: AxisRequirement<ModelAxis>;
  readonly memory?: AxisRequirement<MemoryAxis>;
}

/**
 * The parser for a `requires` block read from a file.
 *
 * Typed against the interface above so the two cannot drift: a value outside
 * the axis union is rejected at load time rather than read as "no requirement".
 */
const axisRequirement = <T extends z.ZodTypeAny>(axis: T): z.ZodUnion<[T, z.ZodArray<T>]> =>
  z.union([axis, z.array(axis).min(1)]);

export const AxisRequirementsSchema: z.ZodType<AxisRequirements> = z.object({
  model: axisRequirement(ModelAxisSchema).optional(),
  memory: axisRequirement(MemoryAxisSchema).optional(),
});

// --- Transcript ------------------------------------------------------------

export { MessageSchema, OutcomeSchema } from '@repo/shared-types';
export type { Message };

/**
 * What the agent said about its own run — `egress` reports `partial` when any
 * tool call carried an error. Re-exported from the contract rather than
 * restated: a second spelling of this union is a second thing to keep true.
 */
export type AgentReportedOutcome = z.infer<typeof OutcomeSchema>;

/**
 * One tool invocation as the graph recorded it.
 *
 * `act` records a failed call as an entry carrying an `error` rather than
 * throwing, so an errored call is a call that *happened and did not succeed* —
 * it belongs in the denominator of tool-call precision and never in the
 * numerator. `trajectory.ts` is where that rule is applied.
 */
export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error?: string;
}

export interface SpanRecord {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface Transcript {
  readonly runId: string;
  readonly sessionId: string;
  readonly messages: readonly Message[];
  /** Node names in the order the graph visited them. */
  readonly nodeSequence: readonly string[];
  readonly toolCalls: readonly ToolCall[];
  readonly retrievedContext: readonly { source: string; content: string; score: number }[];
  readonly tokenCounts: { readonly prompt: number; readonly completion: number };
  /** What the agent reported about itself — not what the environment shows. */
  readonly outcome: AgentReportedOutcome;
  readonly latencyMs: number;
  /**
   * Not populated by the adapter in `apps/agent-service`. The field is here
   * because it is part of the contract P1-B (cassette replay) and P2-C (GenAI
   * span events) consume; P2-C owns filling it.
   */
  readonly spans?: readonly SpanRecord[];
}

// --- Score -----------------------------------------------------------------

/**
 * Shaped to match the OpenTelemetry `gen_ai.evaluation.result` event, so P2-C
 * can emit these as span events with no translation layer:
 *
 *   value       -> gen_ai.evaluation.score.value
 *   label       -> gen_ai.evaluation.score.label
 *   explanation -> gen_ai.evaluation.explanation
 *
 * The attribute that does not come from here is `gen_ai.evaluation.name`, which
 * is the metric name — `Grader.name`. The unit P2-C emits is therefore the
 * (Grader, Score) pair, not the Score alone.
 *
 * Binary by default. Ordinal 1–5 rubrics produce inconsistent labels across
 * annotators and across judge runs; where finer resolution is genuinely needed,
 * decompose into several binary sub-graders and report the fraction satisfied.
 * `pass` and `fail` are among the example values the convention itself gives
 * for `.score.label`.
 */
export interface Score {
  readonly value: number; // normalized 0..1
  readonly label: 'pass' | 'fail';
  readonly explanation?: string; // required for kind === 'model'
}

export type GraderKind = 'code' | 'model' | 'human';

/**
 * The environment state after a trial.
 *
 * Open by design: what counts as "the environment" belongs to the system under
 * test, and this package holds no opinion beyond insisting that a grader be
 * given one. `MemoryOutcome` is this system's — counts read from Postgres,
 * Neo4j and pgvector after the run. Every generic below defaults to it, so a
 * consumer that does not care about outcomes writes `Grader` and not
 * `Grader<unknown>`.
 */
export type Outcome = unknown;

export interface Grader<TOutcome = Outcome> {
  readonly name: string;
  readonly kind: GraderKind;
  /** Axes this grader is only meaningful on. Unmet, the suite refuses to run. */
  readonly requires?: AxisRequirements;
  grade(transcript: Transcript, outcome: TOutcome): Promise<Score>;
}

// --- Task and Suite --------------------------------------------------------

/** The seeded state a task is graded against, restored before every trial. */
export const TaskSeedsSchema = z.object({
  neo4j: z
    .array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() }))
    .default([]),
  relationships: z
    .array(
      z.object({
        fromId: z.string(),
        toId: z.string(),
        type: z.string(),
        confidence: z.number().min(0).max(1),
        episodeId: z.string().uuid(),
      }),
    )
    .default([]),
  pgvector: z
    .array(
      z.object({
        contentHash: z.string(),
        text: z.string(),
        episodeId: z.string().uuid(),
        sessionId: z.string().uuid(),
      }),
    )
    .default([]),
});
export type TaskSeeds = z.infer<typeof TaskSeedsSchema>;

export interface Task<TOutcome = Outcome> {
  readonly id: string;
  readonly description: string;
  /** The request body handed to the system under test. */
  readonly input: unknown;
  readonly seeds: TaskSeeds;
  readonly graders: readonly Grader<TOutcome>[];
}

export interface Suite<TOutcome = Outcome> {
  readonly name: string;
  readonly tasks: readonly Task<TOutcome>[];
  /** Agents are stochastic; one trial measures nothing about reliability. */
  readonly trialsPerTask: number;
}

// --- Trial and results -----------------------------------------------------

export interface GraderResult {
  readonly grader: string;
  readonly kind: GraderKind;
  readonly score: Score;
}

export interface Trial<TOutcome = Outcome> {
  readonly taskId: string;
  readonly index: number;
  readonly transcript: Transcript;
  readonly outcome: TOutcome;
  readonly results: readonly GraderResult[];
  /** A trial passes when every grader on the task passed. */
  readonly passed: boolean;
}

export interface TaskReport<TOutcome = Outcome> {
  readonly taskId: string;
  readonly description: string;
  readonly trials: readonly Trial<TOutcome>[];
  /** At least one of k trials passed. Capability. */
  readonly passAtK: boolean;
  /** All k trials passed. Reliability — it decays as p^k, which is the point. */
  readonly passHatK: boolean;
  /** Fraction of trials that passed, per grader name. */
  readonly perGraderPassRate: Readonly<Record<string, number>>;
}

export interface SuiteReport<TOutcome = Outcome> {
  readonly suite: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly axes: Axes;
  readonly trialsPerTask: number;
  readonly tasks: readonly TaskReport<TOutcome>[];
  /** Trials passed / trials run, across the whole suite. */
  readonly passRate: number;
  /** Graders whose judgements have no calibration set behind them. */
  readonly uncalibratedGraders: readonly string[];
}

// --- The system under test -------------------------------------------------

/**
 * The adapter between the harness and the system under test.
 *
 * It owns the environment: it knows which axes it is on, how to restore the
 * seeded state between trials, and how to read the persisted state afterwards.
 * The harness owns only orchestration and arithmetic, which is what keeps this
 * package free of a database connection of its own.
 */
export interface AgentHarness<TOutcome = Outcome> {
  readonly name: string;
  axes(): Axes;
  /**
   * Restores the task's seeded state. Reset is not "empty the database": a
   * truncate that also removes the seeds makes every trial after the first a
   * different task.
   */
  reset(task: Task<TOutcome>): Promise<void>;
  run(task: Task<TOutcome>): Promise<Transcript>;
  captureOutcome(task: Task<TOutcome>, transcript: Transcript): Promise<TOutcome>;
  close(): Promise<void>;
}
