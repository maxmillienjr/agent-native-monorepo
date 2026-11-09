export { createPgvectorPool, type PgvectorConfig } from './pgvector/pgvector.client.js';
export {
  FactUpsertSchema,
  type PgvectorWriter,
  PgPgvectorWriter,
} from './pgvector/pgvector.writer.js';
export { type PgvectorReader, PgPgvectorReader } from './pgvector/pgvector.reader.js';

export {
  RetrievalQuerySchema,
  RetrievalCandidateSchema,
  type RetrievalQuery,
  type RetrievalCandidate,
  type RetrievalFacade,
  VectorRetrievalFacade,
} from './retrieval-facade.js';
