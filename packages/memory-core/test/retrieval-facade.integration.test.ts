import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import pg from 'pg';
import { CypherNeo4jWriter } from '../src/semantic/neo4j/neo4j.writer.js';
import { CypherNeo4jReader } from '../src/semantic/neo4j/neo4j.reader.js';
import { PgPgvectorWriter } from '../src/semantic/pgvector/pgvector.writer.js';
import { PgPgvectorReader } from '../src/semantic/pgvector/pgvector.reader.js';
import { VectorRetrievalFacade } from '../src/semantic/retrieval-facade.js';
import { EMBEDDING_DIMENSIONS } from '../src/semantic/embedding.js';
import { runMigrations } from '../src/migrate.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'password';

const SKIP = skipUnlessIntegrationEnv(
  'VectorRetrievalFacade (integration)',
  'DATABASE_URL',
  'NEO4J_URI',
);

// Neo4j is seeded here although the facade never reads it. ADR 0009 took the
// graph out of retrieval while `reflect` keeps writing it, so the property
// worth holding is that a fact the graph can reach does not reach a run.
describe.skipIf(SKIP)('VectorRetrievalFacade (integration)', () => {
  let neo4jDriver: Driver;
  let pgPool: pg.Pool;
  let facade: VectorRetrievalFacade;
  let neo4jReader: CypherNeo4jReader;
  let pgReader: PgPgvectorReader;

  beforeAll(async () => {
    neo4jDriver = neo4j.driver(NEO4J_URI!, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    pgPool = new pg.Pool({ connectionString: DATABASE_URL });

    await runMigrations(pgPool);

    // Clear prior test data
    const session = neo4jDriver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
    await pgPool.query('DELETE FROM semantic_facts');

    // Seed Neo4j with test entities and relationships
    const neo4jWriter = new CypherNeo4jWriter(neo4jDriver);
    await neo4jWriter.mergeEntity({
      id: 'langgraph',
      label: 'LangGraph',
      description: 'Framework for stateful agents.',
    });
    await neo4jWriter.mergeEntity({
      id: 'memory',
      label: 'Memory',
      description: 'Agent memory system.',
    });
    await neo4jWriter.mergeEntity({
      id: 'neo4j-concept',
      label: 'Neo4j',
      description: 'Graph database.',
    });
    await neo4jWriter.mergeRelationship({
      fromId: 'langgraph',
      toId: 'memory',
      type: 'USES',
      confidence: 0.95,
      episodeId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
    });
    await neo4jWriter.mergeRelationship({
      fromId: 'memory',
      toId: 'neo4j-concept',
      type: 'STORED_IN',
      confidence: 0.9,
      episodeId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
    });

    // Seed pgvector with test embeddings
    const pgWriter = new PgPgvectorWriter(pgPool);
    const makeEmbedding = (seed: number) =>
      new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => Math.sin((i + seed) * 0.01));

    await pgWriter.upsertFact({
      contentHash: 'sha256-facade-test-1',
      text: 'LangGraph enables stateful agent workflows with memory.',
      embedding: makeEmbedding(1),
      episodeId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
    });
    await pgWriter.upsertFact({
      contentHash: 'sha256-facade-test-2',
      text: 'Semantic memory combines Neo4j and pgvector.',
      embedding: makeEmbedding(2),
      episodeId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
    });

    // A fact belonging to a different session, to prove retrieval is scoped.
    await pgWriter.upsertFact({
      contentHash: 'sha256-facade-other-session',
      text: 'A fact written while working in another session entirely.',
      embedding: makeEmbedding(1),
      episodeId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-4466554400bb',
    });

    // Write facts into Neo4j as `reflect` does, keyed on the hashes pgvector
    // uses (ADR 0004): one the vector index also holds, and one only the
    // graph holds, reachable from `langgraph` in one hop.
    await neo4jWriter.mergeFact({
      contentHash: 'sha256-facade-test-1',
      text: 'LangGraph enables stateful agent workflows with memory.',
      episodeId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
      entityIds: ['langgraph'],
    });
    await neo4jWriter.mergeFact({
      contentHash: 'sha256-facade-graph-only',
      text: 'Graph traversal reaches facts no vector search returned.',
      episodeId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
      entityIds: ['langgraph'],
    });

    neo4jReader = new CypherNeo4jReader(neo4jDriver);
    pgReader = new PgPgvectorReader(pgPool);
    facade = new VectorRetrievalFacade(pgReader);
  });

  afterAll(async () => {
    await neo4jDriver.close();
    await pgPool.end();
  });

  const sessionA = '550e8400-e29b-41d4-a716-446655440001';
  const queryEmbedding = new Array(EMBEDDING_DIMENSIONS)
    .fill(0)
    .map((_, i) => Math.sin((i + 1) * 0.01));

  it('returns the vector reader’s list for the session, and nothing from the graph', async () => {
    const results = await facade.retrieve({ queryEmbedding, topK: 10, sessionId: sessionA });
    const direct = await pgReader.searchByCosine(queryEmbedding, 10, { sessionId: sessionA });

    expect(results.length).toBeGreaterThan(0);
    expect(results).toEqual(direct);
    expect(new Set(results.map((r) => r.source))).toEqual(new Set(['pgvector']));
  });

  it('does not return a fact only the graph holds, though the graph reaches it', async () => {
    // The graph still holds and reaches the fact, so its absence below is the
    // facade not reading the graph, and not a seed that failed to land.
    const reachable = await neo4jReader.expandFromSeeds(['langgraph'], 1, { sessionId: sessionA });
    expect(reachable.map((c) => c.contentHash)).toContain('sha256-facade-graph-only');

    const results = await facade.retrieve({
      queryEmbedding,
      topK: 10,
      sessionId: sessionA,
      crossSession: true,
    });
    expect(results.map((r) => r.contentHash)).not.toContain('sha256-facade-graph-only');
  });

  describe('session scoping', () => {
    it('does not return a fact written in another session', async () => {
      const results = await facade.retrieve({
        queryEmbedding,
        sessionId: sessionA,
      });

      expect(results.map((r) => r.contentHash)).not.toContain('sha256-facade-other-session');
    });

    it('returns it when crossSession is set', async () => {
      const results = await facade.retrieve({
        queryEmbedding,
        sessionId: sessionA,
        crossSession: true,
      });

      expect(results.map((r) => r.contentHash)).toContain('sha256-facade-other-session');
    });
  });

  it('returns cosine scores in monotonically decreasing order', async () => {
    const results = await facade.retrieve({ queryEmbedding, topK: 10, sessionId: sessionA });

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });
});
