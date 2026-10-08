// Working Memory — per-run, in-process, ephemeral
export {
  WorkingMemorySchema,
  type WorkingMemory,
  seedWorkingMemory,
  mergeRetrievedContext,
  appendToolOutput,
  addTokenCounts,
} from './working/index.js';

// Schema ownership — the only DDL for every table this package owns
export { runMigrations } from './migrate.js';

// Episodic Memory — session-scoped, Postgres + Drizzle
export { episodes } from './episodic/schema.js';
export {
  EpisodeFindInputSchema,
  EpisodeWriteInputSchema,
  type EpisodeFindInput,
  type EpisodeWriteInput,
  type EpisodicRepository,
  DrizzleEpisodicRepository,
} from './episodic/episodic.repo.js';

// Prior-authorization cases (P3-E, ADR 0010) — the queue, the clock and the
// determination for every request `$submit` received. Postgres on the
// configured memory axis, a volatile in-process store on the unconfigured one.
export {
  priorAuthCases,
  CaseStatusSchema,
  NewCaseSchema,
  DecisionSchema,
  CaseRowSchema,
  CaseExampleSchema,
  DrizzleCaseRepository,
  InMemoryCaseRepository,
  type CaseStatus,
  type NewCase,
  type Decision,
  type CaseRow,
  type CaseExample,
  type CaseRepository,
  type DecideResult,
  type DecideOptions,
  type OverdueCase,
} from './cases/index.js';

// Appeals (P3-F): requests for reconsideration of a denied case, beside the
// case they reference, with the same two stores.
export {
  priorAuthAppeals,
  AppealStatusSchema,
  ForwardReasonSchema,
  DismissalReasonSchema,
  FilerSchema,
  AppealRequestSchema,
  DismissalSchema,
  SignedActionSchema,
  NewAppealSchema,
  AppealRowSchema,
  LAPSE_EXPLANATION,
  caseFileOf,
  caseFileDigest,
  DrizzleAppealRepository,
  InMemoryAppealRepository,
  type AppealStatus,
  type ForwardReason,
  type DismissalReason,
  type Filer,
  type Dismissal,
  type SignedAction,
  type NewAppeal,
  type AppealRow,
  type FileResult,
  type ActionResult,
  type ActionOptions,
  type ReconsiderOptions,
  type FileOptions,
  type ForwardOptions,
  type ForwardedAppeal,
  type AppealRepository,
} from './cases/index.js';

// Semantic Memory — the embedding dimension every schema and DDL derives from
export { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, l2Normalize } from './semantic/embedding.js';

// Semantic Memory — Neo4j knowledge graph. `reflect` writes it, every write and
// read is scoped to a session (P2-D's M1), and no request reads it since
// ADR 0009. The reader is kept for the P2-B ablation, and the explainer is what
// P2-D measures.
export {
  EntityWriteSchema,
  RelationshipWriteSchema,
  FactWriteSchema,
  type Neo4jWriter,
  CypherNeo4jWriter,
} from './semantic/neo4j/neo4j.writer.js';
export {
  type GraphReadScope,
  type Neo4jReader,
  CypherNeo4jReader,
} from './semantic/neo4j/neo4j.reader.js';
export {
  MAX_EXPLANATION_HOPS,
  MAX_PATHS_PER_FACT,
  type ConceptPath,
  type ExplanationScope,
  type Neo4jExplainer,
  CypherNeo4jExplainer,
  assembleExplanations,
  compareConceptPaths,
  conceptPathKey,
  matchConceptLabels,
} from './semantic/neo4j/neo4j.explainer.js';
export { createNeo4jClient } from './semantic/neo4j/neo4j.client.js';
export { ensureSemanticConstraints } from './semantic/neo4j/neo4j.constraints.js';

// Semantic Memory — pgvector dense embeddings
export {
  FactUpsertSchema,
  type PgvectorWriter,
  PgPgvectorWriter,
} from './semantic/pgvector/pgvector.writer.js';
export {
  type PgvectorReader,
  type PgvectorSearchScope,
  PgPgvectorReader,
} from './semantic/pgvector/pgvector.reader.js';
export { createPgvectorPool } from './semantic/pgvector/pgvector.client.js';

// Retrieval Facade — session-scoped pgvector search; vector-only since ADR 0009
export {
  RetrievalQuerySchema,
  RetrievalCandidateSchema,
  type RetrievalQuery,
  type RetrievalQueryInput,
  type RetrievalCandidate,
  type RetrievalFacade,
  VectorRetrievalFacade,
} from './semantic/retrieval-facade.js';

// The run record (P3-B) — what a production run received and decided, beside
// its checkpoints. Not a memory tier: nothing in a graph reads it, and
// `audit:replay` is its reader. Here because it is written with the role that
// writes everything else in this package (ADR 0007).
export {
  GitShaSchema,
  RECORD_SEAMS,
  RETRIEVAL_SEAM,
  RUN_DECISION_FORMAT_VERSION,
  RecordedModelAxisSchema,
  RunDecisionRowSchema,
  RunDecisionSchema,
  RunGraphSchema,
  RunOutcomeSchema,
  RunRecordOpenSchema,
  RunRecordSchema,
  type RecordSeam,
  type RecordedModelAxis,
  type RunDecision,
  type RunDecisionRow,
  type RunGraph,
  type RunOutcome,
  type RunRecord,
  type RunRecordOpen,
  type RunRecordRepository,
  type StoredRun,
  PgRunRecordRepository,
  createReadOnlyPool,
} from './audit/index.js';

// Inspection — reading back what one run persisted, and restoring a session to
// its seeded state between evaluation trials. The read surface exists so that
// `packages/eval-harness` can assert against persisted state without opening a
// pool of its own; see `.agents/reviewer.md` rule 4.
export {
  RunInspectionInputSchema,
  type RunInspectionInput,
  type RunInspection,
  type MemoryInspector,
  PgNeo4jMemoryInspector,
  SeedStateSchema,
  SeedApplicationSchema,
  type SeedState,
  type SeedApplication,
  type SeedManager,
  PgNeo4jSeedManager,
} from './inspect/index.js';
