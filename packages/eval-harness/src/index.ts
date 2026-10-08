// The vocabulary — the types every consumer of this package builds on. P1-B
// (cassette replay), P1-C (the tiered pipeline), P1-D (the statistical gate),
// P1-E (the drift canary), P1-F (budget assertions) and P2-B (the retrieval
// ablation) are all consumers of these.
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
  entityMerged,
  factsPersistedToBothIndices,
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

// Dataset format and loader.
export {
  EVAL_DATASETS_DIR,
  MEMORY_RECALL_DATASET_DIR,
  MEMORY_RECALL_SUITE,
  TaskSpecSchema,
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

// Retrieval metrics — a ranked list per query, not a trial, so not `Grader`s.
export { recallAtK, reciprocalRank, ndcgAtK } from './retrieval/metrics.js';

// The fusion the service ran until ADR 0009; the ablation is its only caller.
export { rrfMerge } from './retrieval/rrf.js';

// The retrieval-ablation dataset: corpus, labelled queries, and the checks
// that hold each stratum to its declared construction.
export {
  RETRIEVAL_ABLATION_DATASET_DIR,
  CorpusSchema,
  CorpusEpisodeSchema,
  LabelledQuerySchema,
  QuerySetSchema,
  STRATA,
  StratumSchema,
  adjacency,
  buildRetrievalDataset,
  datasetProblems,
  datasetSha256,
  graphFacts,
  loadRetrievalDataset,
  mentionCounts,
  sha256Hex,
  strataProblems,
  textsToEmbed,
  wordJaccard,
  type Corpus,
  type CorpusEpisode,
  type CorpusFact,
  type GraphFactSeed,
  type GraphShape,
  type LabelledQuery,
  type RetrievalDataset,
  type Stratum,
} from './retrieval/dataset.js';

// The ablation's arithmetic and its report.
export {
  DECISION_MARGIN,
  GRAPH_READER_LIMIT,
  K_VALUES,
  TIE_SALTS,
  applyDecisionRule,
  buildPool,
  conditionScores,
  fusionReproduced,
  limitCut,
  meanScores,
  percentile,
  provenance,
  queryIndex,
  reachableFacts,
  resortTies,
  scoreList,
  summarizeCondition,
  type ConditionKind,
  type ConditionSummary,
  type K,
  type Labels,
  type LimitCut,
  type MetricMeans,
  type PoolCandidate,
  type PoolKeyEntry,
  type PoolQuery,
  type ProvenanceSplit,
  type QueryScores,
  type RawCondition,
  type RawQueryResult,
  type RuleOutcome,
  type SeedSource,
  type TieRange,
} from './retrieval/evaluate.js';
export {
  ADJUDICATION_DIR,
  DecisionsFileSchema,
  POOL_INSTRUCTIONS,
  PoolCandidatesFileSchema,
  PoolKeyFileSchema,
  adjudicatedLabels,
  adjudicationPaths,
  renderPoolFiles,
  type DecisionsFile,
} from './retrieval/adjudication.js';
export {
  buildAblationReport,
  outcomeRow,
  type OutcomeRow,
  renderAblationJson,
  renderAblationMarkdown,
  type AblationInput,
  type AblationReport,
  type AdjudicationSummary,
  type Comparison,
  type LabelSetReport,
} from './retrieval/report.js';

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
  compareLive,
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
  type GateResult,
  type GateVerdict,
} from './gate/render.js';
