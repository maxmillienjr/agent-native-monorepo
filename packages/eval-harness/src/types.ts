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

/**
 * What a grader or a task needs to be meaningful.
 *
 * The two are read the same way and acted on differently: an unmet grader
 * requirement stops the suite, an unmet task requirement removes that task from
 * the run and is reported. `axes.ts` carries the argument for the asymmetry.
 */
export interface AxisRequirements {
  readonly model?: AxisRequirement<ModelAxis>;
  readonly memory?: AxisRequirement<MemoryAxis>;
}

/**
 * The parser for the `requires` block of a task file.
 *
 * Typed against the interface above so the two cannot drift: a value outside
 * the axis union is rejected at load time rather than read as "no requirement"
 * and silently running a task on an axis it declared it could not use.
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

/**
 * One finished span, as much of it as a consumer needs to rebuild the tree
 * without an OpenTelemetry dependency of its own.
 *
 * Times are milliseconds. On the `replay` axis an inference span's duration is
 * replay speed, not the model's latency, and such a span carries
 * `agent_native.replayed`; a reader of durations filters on it.
 */
export interface SpanRecord {
  readonly name: string;
  readonly kind: 'internal' | 'client' | 'server' | 'producer' | 'consumer';
  readonly traceId: string;
  readonly spanId: string;
  /** Absent on the root. */
  readonly parentSpanId?: string;
  readonly startTimeUnixMs: number;
  readonly durationMs: number;
  readonly status: 'unset' | 'ok' | 'error';
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
   * The run's trace: every span under its `invoke_agent` root, and nothing the
   * harness did around the run. `apps/agent-service` fills it on every axis.
   * Optional because an `AgentHarness` that collects no spans is still a valid
   * one; its evaluation events are emitted unparented.
   */
  readonly spans?: readonly SpanRecord[];
}

// --- Score -----------------------------------------------------------------

/**
 * Shaped to match the OpenTelemetry `gen_ai.evaluation.result` event, which
 * `telemetry.ts` emits for every grader result with no translation layer:
 *
 *   value       -> gen_ai.evaluation.score.value
 *   label       -> gen_ai.evaluation.score.label
 *   explanation -> gen_ai.evaluation.explanation
 *
 * The attribute that does not come from here is `gen_ai.evaluation.name`, which
 * is the metric name — `Grader.name`. The unit emitted is therefore the
 * (Grader, Score) pair, not the Score alone. It is a log record through the
 * Logs API, parented to the run's `invoke_agent` span — not a span event:
 * `Span.addEvent` is the API OTEP 4430 deprecates, and the convention defines
 * the result as an event in the Logs data model.
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
  /**
   * Facts written to the graph only, each linked by `MENTIONS` to the concepts
   * in `entityIds`.
   *
   * Without it no task can reach the graph retriever: `expandFromSeeds`
   * returns `:Fact` nodes, and `neo4j` and `relationships` write none. A fact
   * here and not in `pgvector` is one only the graph can return, which is what
   * lets a grader attribute it.
   */
  graphFacts: z
    .array(
      z.object({
        contentHash: z.string(),
        text: z.string(),
        episodeId: z.string().uuid(),
        entityIds: z.array(z.string()).min(1),
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
  /**
   * Axes this task is meaningful on. Unmet, the task is skipped and the
   * skip is reported beside the rate — it does not stop the suite.
   */
  readonly requires?: AxisRequirements;
  /**
   * A cap on this task's trials, below `Suite.trialsPerTask`. Raising it is not
   * possible on purpose: the suite's figure is the ceiling.
   *
   * It exists for replay. A task has as many replayable trials as it has
   * cassettes, and running a suite of five over a set of one would replay one
   * recording five times and report `pass^k = pass@k` — a single sample
   * presented as a reliability measurement.
   */
  readonly trialsPerTask?: number;
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
  /**
   * How many trials this task was run for, which is `Suite.trialsPerTask`
   * unless the task capped it. Stated rather than left to `trials.length`,
   * because `pass^k` is only readable next to the k it was computed over.
   */
  readonly trialsPerTask: number;
  /** At least one of k trials passed. Capability. */
  readonly passAtK: boolean;
  /** All k trials passed. Reliability — it decays as p^k, which is the point. */
  readonly passHatK: boolean;
  /** Fraction of trials that passed, per grader name. */
  readonly perGraderPassRate: Readonly<Record<string, number>>;
}

/**
 * A task that was not run, and what it needed.
 *
 * It exists so the exclusion travels with the number. A skipped task
 * contributes no trials, so dropping it from the denominator without saying so
 * turns a misleading rate into a flattering one, which is worse.
 */
export interface SkippedTask {
  readonly taskId: string;
  readonly problems: readonly string[];
}

/**
 * Which recording a replayed number came out of.
 *
 * A replayed `pass^k` is a property of the cassette set as much as of the code,
 * and the two things that say whether it still means anything are when the set
 * was recorded and against which commit. Without them a report from a set
 * recorded before a prompt edit is indistinguishable from one recorded after.
 */
export interface ReplayProvenance {
  /**
   * The oldest `recordedAt` in the set. The oldest rather than the newest
   * because the question the field answers is how stale the set is.
   */
  readonly recordedAt: string;
  /**
   * The commit the set was recorded at. A set recorded in one run is uniform;
   * a mixed set lists every sha it holds, comma-separated, rather than picking
   * one to present as the answer.
   */
  readonly gitSha: string;
  /** How many cassettes this run played. */
  readonly cassettes: number;
}

/**
 * The model ids a run's numbers came from.
 *
 * The axis says whether a model was called; this says which one. Without it a
 * run on the floating alias (`EVAL_CHAT_MODEL`, P1-E) reads exactly like a
 * run on the pinned id. On the `live` axis it is the running configuration;
 * on `replay` it is what the cassette headers recorded, which the player has
 * already checked equal to the running configuration.
 */
export interface ModelIds {
  readonly chat: string;
  readonly embedding: string;
}

export interface SuiteReport<TOutcome = Outcome> {
  readonly suite: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly axes: Axes;
  readonly trialsPerTask: number;
  /** Present exactly when `axes.model` is `replay`. The runner enforces both halves. */
  readonly replay?: ReplayProvenance;
  /**
   * Present exactly when `axes.model` is `live` or `replay`. The stub axis
   * calls no model, so naming one there would attribute canned strings to it.
   */
  readonly models?: ModelIds;
  readonly tasks: readonly TaskReport<TOutcome>[];
  /** Trials passed / trials run — over the tasks that ran, not over `tasks`. */
  readonly passRate: number;
  /** Tasks excluded from the run, and therefore from `passRate`. */
  readonly skipped: readonly SkippedTask[];
  /** Graders whose judgements have no calibration set behind them. */
  readonly uncalibratedGraders: readonly string[];
  /**
   * The OpenTelemetry GenAI conventions commit the transcripts' span
   * attributes and the evaluation events follow — `GENAI_SEMCONV.commit`.
   *
   * The conventions are in Development status and move; a comparison of two
   * reports across a bump (P1-D's) has to know that the names changed under
   * it, and one field now is cheaper than migrating stored reports later.
   */
  readonly genAiSemconvCommit: string;
}

// --- A run that did not complete --------------------------------------------

/**
 * A trial that finished before the run aborted, reduced to what a reader acts
 * on. The transcript stays out: an abort file is read to find out what broke,
 * and the run that would own the transcripts never produced a report.
 */
export interface CompletedTrial {
  readonly taskId: string;
  readonly index: number;
  readonly runId: string;
  readonly passed: boolean;
  readonly failedGraders: readonly string[];
}

/** The error that ended the run, with whatever structured detail it carried. */
export interface AbortError {
  readonly name: string;
  readonly message: string;
  readonly status?: number;
  /** A model client's `google.rpc` details, kept whole: they are what names a quota. */
  readonly errorDetails?: unknown;
}

/**
 * Why the run stopped, in words someone can act on, when the caller could tell.
 * `code` is stable for a reader such as P1-D; `summary` and `remedy` are prose.
 */
export interface AbortCause {
  readonly code: string;
  readonly summary: string;
  readonly remedy?: string;
}

/**
 * The record of a run that stopped before it had a report to write.
 *
 * Aborted is not failed. A failed suite completed and graded something; an
 * aborted one did not complete, so it has no pass rate, and `eval-report.json`
 * is never written beside this — its presence is the signal that a run
 * completed. The exit code cannot carry the difference, because Turbo reduces
 * every failing task to 1.
 */
export interface EvalAbort {
  readonly suite: string;
  readonly startedAt: string;
  readonly abortedAt: string;
  /** Absent when the run stopped before the axes were read. */
  readonly axes?: Axes;
  readonly replay?: ReplayProvenance;
  readonly error: AbortError;
  readonly cause?: AbortCause;
  /** In the order they finished. A run that dies on its last call keeps the rest. */
  readonly completedTrials: readonly CompletedTrial[];
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
