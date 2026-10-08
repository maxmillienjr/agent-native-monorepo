export { createNeo4jClient, type Neo4jConfig } from './neo4j/neo4j.client.js';
export {
  EntityWriteSchema,
  RelationshipWriteSchema,
  type Neo4jWriter,
  CypherNeo4jWriter,
} from './neo4j/neo4j.writer.js';
export { type Neo4jReader, CypherNeo4jReader } from './neo4j/neo4j.reader.js';

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
