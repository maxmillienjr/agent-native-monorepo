// Working Memory — per-run, in-process, ephemeral
export {
  WorkingMemorySchema,
  type WorkingMemory,
  seedWorkingMemory,
  mergeRetrievedContext,
  appendToolOutput,
  addTokenCounts,
} from './working/index.js';

// Schema ownership — the only DDL for `episodes` and `semantic_facts`
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
