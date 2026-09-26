// The vocabulary — the types every consumer of this package builds on. P1-B
// (cassette replay), P1-C (the tiered pipeline), P1-D (the statistical gate),
// P1-E (the drift canary), P1-F (budget assertions) and P2-B (the retrieval
// ablation) are all consumers of these.
export {
  AxisRequirementsSchema,
  MemoryAxisSchema,
  MessageSchema,
  ModelAxisSchema,
  OutcomeSchema,
  TaskSeedsSchema,
  type AgentReportedOutcome,
  type AgentHarness,
  type Axes,
  type AxisRequirement,
  type AxisRequirements,
  type Grader,
  type GraderKind,
  type GraderResult,
  type MemoryAxis,
  type Message,
  type ModelAxis,
  type Outcome,
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
} from './types.js';

// The environment state a grader for this system asserts against.
export type { MemoryOutcome } from './outcome.js';

// Which axis a trial is running on, the refusal when a grader needs one it does
// not have, and the skip when a task does.
export {
  detectAxes,
  describeAxes,
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
} from './dataset.js';

// The vector a seeded fact is stored with.
export { fixtureEmbedding } from './fixture-embedding.js';

// Runner.
export { EvalHarness, trialsFor, type EvalHarnessOptions } from './harness.js';

// Reporters.
export { renderJsonReport } from './reporters/json.js';
export { renderJUnitReport } from './reporters/junit.js';
export { renderMarkdownSummary } from './reporters/summary.js';

// Retrieval metrics — a ranked list per query, not a trial, so not `Grader`s.
export { recallAtK, reciprocalRank, ndcgAtK } from './retrieval/metrics.js';

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

// Statistics — nothing here knows what a query is; P1-D needs the same interval.
export {
  DEFAULT_BOOTSTRAP_SEED,
  mulberry32,
  pairedBootstrap,
  pairsToResolve,
  type PairedBootstrapOptions,
  type PairedBootstrapResult,
} from './stats/paired-bootstrap.js';
