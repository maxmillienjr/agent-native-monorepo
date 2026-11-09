// The vocabulary — the types every consumer of this package builds on. P1-B
// (cassette replay), P1-C (the tiered pipeline), P1-D (the statistical gate),
// P1-E (the drift canary) and P1-F (budget assertions) are all consumers of
// these.
export {
  AxisRequirementsSchema,
  BUDGET_NAMES,
  BudgetsSchema,
  MemoryAxisSchema,
  MessageSchema,
  ModelAxisSchema,
  OutcomeSchema,
  TaskSeedsSchema,
  type AbortCause,
  type AbortError,
  type AgentReportedOutcome,
  type AgentHarness,
  type Axes,
  type AxisRequirement,
  type AxisRequirements,
  type BudgetName,
  type BudgetResult,
  type Budgets,
  type CompletedTrial,
  type CostEstimate,
  type EvalAbort,
  type Grader,
  type GraderKind,
  type GraderResult,
  type MemoryAxis,
  type Message,
  type ModelAxis,
  type Outcome,
  type ModelIds,
  type PriceTable,
  type ReplayProvenance,
  type Score,
  type SkippedTask,
  type SpanRecord,
  type SuiteFigure,
  type Suite,
  type SuiteReport,
  type Task,
  type TaskReport,
  type TaskSeeds,
  type ToolCall,
  type Transcript,
  type Trial,
  type TrialUsage,
  type UsageReport,
} from './types.js';

// The environment state a grader for this system asserts against.
export type { MemoryOutcome } from './outcome.js';

// Which axis a trial is running on, the refusal when a grader needs one it does
// not have, and the skip when a task does.
export {
  detectAxes,
  describeAxes,
  assertExpectedAxes,
  AxisExpectationError,
  readCassetteMode,
  assertAxesSatisfy,
  skippedTasks,
  unmetRequirements,
  AxisRequirementError,
  type CassetteMode,
} from './axes.js';

// Graders.
export {
  retrievedContextMinLength,
  outcomeMustBe,
  tokenCountsPositive,
  episodicRowWritten,
  semanticFactWritten,
} from './graders/code.js';
export {
  ModelGrader,
  SameFamilyJudgeError,
  humanLabelGrader,
  type JudgeCalibration,
  type LabelledExample,
  type ModelGraderOptions,
  type ModelJudge,
} from './graders/model.js';
export {
  computeTrajectoryMetrics,
  nodeSteps,
  toolSteps,
  trajectoryGraders,
  TRAJECTORY_METRICS,
  type TrajectoryMetricName,
  type TrajectoryMetrics,
  type TrajectoryReference,
  type TrajectoryStep,
} from './graders/trajectory.js';

// The memory-poisoning red team's canary graders (P4-B).
export {
  RED_TEAM_SURFACES,
  canaryAbsentFromAnswer,
  canaryAbsentFromContext,
  canaryAbsentFromExtraction,
  canaryExcerpt,
  redTeamGraders,
  type RedTeamSurface,
} from './graders/red-team.js';

// Dataset format and loader.
export {
  EVAL_DATASETS_DIR,
  MEMORY_RECALL_DATASET_DIR,
  MEMORY_RECALL_SUITE,
  PINNED_ATLAS_IDS,
  PINNED_OWASP_IDS,
  RED_TEAM_DATASET_DIR,
  RED_TEAM_SUITE,
  RedTeamSpecSchema,
  TaskInputSchema,
  TaskSpecSchema,
  type RedTeamSpec,
  type TaskSpec,
  buildGraders,
  capTrialsToCassettes,
  cassettePath,
  cassettesDir,
  countCassettes,
  taskFromSpec,
  loadTaskSpec,
  loadSuite,
  loadMemoryRecallSuite,
  loadRedTeamSuite,
  readTaskFilter,
  selectTasks,
} from './dataset.js';

// The vector a seeded fact is stored with.
export { fixtureEmbedding } from './fixture-embedding.js';

// Budgets beside the pass rate, and what a trial used (P1-F).
export { checkBudgets, estimateCost, trialUsage } from './budgets.js';

// Runner.
export { EvalHarness, trialsFor, type EvalHarnessOptions } from './harness.js';

// The `gen_ai.evaluation.result` events the runner emits for every grader result.
export { emitEvaluationResults, rootSpanRecord } from './telemetry.js';

// Reporters.
export { renderJsonReport } from './reporters/json.js';
export { renderJUnitReport } from './reporters/junit.js';
export { renderMarkdownSummary } from './reporters/summary.js';

export {
  abortError,
  completedTrial,
  renderAbortJson,
  renderAbortSummary,
} from './reporters/abort.js';

// Statistics — nothing here knows what a query is; P1-D needs the same interval.
export {
  DEFAULT_BOOTSTRAP_SEED,
  mulberry32,
  pairedBootstrap,
  pairsToResolve,
  type PairedBootstrapOptions,
  type PairedBootstrapResult,
} from './stats/paired-bootstrap.js';
export {
  stratifiedBootstrap,
  type StratifiedBootstrapResult,
  type StratifiedSample,
} from './stats/stratified-bootstrap.js';

// The regression gate (P1-D): the committed baselines, the live evidence, and
// the two comparisons.
export {
  GradedReportSchema,
  LivePoolSchema,
  LiveReferenceSchema,
  LiveRunSchema,
  LiveTallySchema,
  ReplayBaselineSchema,
  ReplayCellSchema,
  baselinesDir,
  cassetteSetDigest,
  compareCells,
  digestFiles,
  epochDir,
  liveReferencePath,
  liveTally,
  loadLiveReference,
  loadReplayBaseline,
  poolTallies,
  renderReplayBaseline,
  replayBaseline,
  replayBaselinePath,
  replayCells,
  tallyPath,
  type DigestInput,
  type GradedReport,
  type LivePool,
  type LiveReference,
  type LiveRun,
  type LiveTally,
  type ReplayBaseline,
  type ReplayCell,
} from './gate/baseline.js';
export {
  REPLAY_DIFFERENCE_KINDS,
  compareReplay,
  countDifferences,
  type ReplayComparison,
  type ReplayDifference,
  type ReplayDifferenceKind,
} from './gate/compare-replay.js';
export {
  LIVE_DELTA,
  TASKS_RANDOM_FROM,
  TASKS_RANDOM_TRIAL_FLOOR,
  compareLive,
  liveRegime,
  regimeFloor,
  trialFloor,
  type CompareLiveOptions,
  type LiveComparison,
  type LiveRegime,
  type LiveTaskArms,
  type LiveVerdict,
} from './gate/compare-live.js';
export {
  gateBlocks,
  renderGateJson,
  renderGateSection,
  renderPool,
  renderZeroTolerance,
  type GateResult,
  type GateVerdict,
} from './gate/render.js';
export {
  checkZeroTolerance,
  type ZeroToleranceCheck,
  type ZeroToleranceCount,
  type ZeroToleranceFailure,
  type ZeroToleranceGraders,
} from './gate/zero-tolerance.js';

// The prior-authorization suite (P3-D): its dataset, graders and figures.
export {
  PRIOR_AUTH_DATASET_DIR,
  PRIOR_AUTH_SUITE,
  PriorAuthLabelSchema,
  PriorAuthTaskSpecSchema,
  loadPriorAuthLabels,
  loadPriorAuthSuite,
  type PriorAuthLabel,
  type PriorAuthLabels,
  type PriorAuthTaskSpec,
} from './prior-auth/dataset.js';
export {
  citationsResolve,
  dispositionKind,
  findingAgreement,
  noFalseApproval,
  type PriorAuthOutcome,
} from './prior-auth/graders.js';
export { priorAuthFigures } from './prior-auth/figures.js';
