import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import pg from 'pg';
import { CypherNeo4jWriter } from '../src/semantic/neo4j/neo4j.writer.js';
import { PgPgvectorWriter } from '../src/semantic/pgvector/pgvector.writer.js';
import { PgPgvectorReader } from '../src/semantic/pgvector/pgvector.reader.js';
import { EMBEDDING_DIMENSIONS } from '../src/semantic/embedding.js';
import { runMigrations } from '../src/migrate.js';
import { ensureSemanticConstraints } from '../src/semantic/neo4j/neo4j.constraints.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'password';

const SKIP = skipUnlessIntegrationEnv('Semantic Memory (integration)', 'DATABASE_URL', 'NEO4J_URI');

describe.skipIf(SKIP)('Semantic Memory (integration)', () => {
  let neo4jDriver: Driver;
  let pgPool: pg.Pool;
  let neo4jWriter: CypherNeo4jWriter;
  let pgWriter: PgPgvectorWriter;

  beforeAll(async () => {
    neo4jDriver = neo4j.driver(NEO4J_URI!, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    pgPool = new pg.Pool({ connectionString: DATABASE_URL });

    await runMigrations(pgPool);

    // Clear test data
    const session = neo4jDriver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
    await pgPool.query('DELETE FROM semantic_facts');

    await ensureSemanticConstraints(neo4jDriver);

    neo4jWriter = new CypherNeo4jWriter(neo4jDriver);
    pgWriter = new PgPgvectorWriter(pgPool);
  });

  afterAll(async () => {
    await neo4jDriver.close();
    await pgPool.end();
  });

  describe('ensureSemanticConstraints', () => {
    it('declares uniqueness on :Concept(id) and :Fact(contentHash)', async () => {
      // MERGE without these is not safe under concurrency: two transactions
      // can each fail to find the node and each create it, which is the
      // duplicate the writer's idempotency is supposed to rule out.
      const session = neo4jDriver.session();
      try {
        const result = await session.run('SHOW CONSTRAINTS');
        const declared = result.records.map((r) => ({
          labels: r.get('labelsOrTypes') as string[],
          properties: r.get('properties') as string[],
          type: r.get('type') as string,
        }));

        expect(declared).toContainEqual(
          expect.objectContaining({ labels: ['Concept'], properties: ['id'] }),
        );
        expect(declared).toContainEqual(
          expect.objectContaining({ labels: ['Fact'], properties: ['contentHash'] }),
        );
      } finally {
        await session.close();
      }
    });

    it('is idempotent across boots', async () => {
      await expect(ensureSemanticConstraints(neo4jDriver)).resolves.toBeUndefined();
    });
  });

  describe('Neo4jWriter idempotency', () => {
    it('merges an entity without creating duplicates', async () => {
      const entity = { id: 'concept-a', label: 'Concept A', description: 'A test concept.' };

      await neo4jWriter.mergeEntity(entity);
      await neo4jWriter.mergeEntity(entity);

      const session = neo4jDriver.session();
      try {
        const result = await session.run('MATCH (c:Concept {id: $id}) RETURN count(c) AS cnt', {
          id: 'concept-a',
        });
        const count = result.records[0]!.get('cnt').toNumber();
        expect(count).toBe(1);
      } finally {
        await session.close();
      }
    });

    it('merges a relationship without creating duplicates', async () => {
      await neo4jWriter.mergeEntity({ id: 'concept-a', label: 'Concept A' });
      await neo4jWriter.mergeEntity({ id: 'concept-b', label: 'Concept B' });

      const rel = {
        fromId: 'concept-a',
        toId: 'concept-b',
        type: 'SUPPORTS',
        confidence: 0.85,
        episodeId: '550e8400-e29b-41d4-a716-446655440000',
      };

      await neo4jWriter.mergeRelationship(rel);
      await neo4jWriter.mergeRelationship(rel);

      const session = neo4jDriver.session();
      try {
        const result = await session.run(
          `MATCH (:Concept {id: 'concept-a'})-[r:RELATES_TO]->(:Concept {id: 'concept-b'})
           RETURN count(r) AS cnt`,
        );
        const count = result.records[0]!.get('cnt').toNumber();
        expect(count).toBe(1);
      } finally {
        await session.close();
      }
    });
  });

  describe('PgvectorWriter idempotency', () => {
    it('upserts a fact without creating duplicates', async () => {
      const embedding = new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => Math.sin(i * 0.01));
      const fact = {
        contentHash: 'sha256-test-fact-1',
        text: 'LangGraph enables stateful agent workflows.',
        embedding,
        episodeId: '550e8400-e29b-41d4-a716-446655440000',
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
      };

      await pgWriter.upsertFact(fact);
      await pgWriter.upsertFact(fact);

      const result = await pgPool.query(
        'SELECT count(*) AS cnt FROM semantic_facts WHERE content_hash = $1',
        ['sha256-test-fact-1'],
      );
      expect(parseInt(result.rows[0].cnt, 10)).toBe(1);
    });
  });

  describe('PgvectorReader plan', () => {
    it('explains the statement searchByCosine runs, in both scopes', async () => {
      const reader = new PgPgvectorReader(pgPool);
      const embedding = new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => Math.cos(i * 0.01));

      const scoped = await reader.explainSearchByCosine(embedding, 10, {
        sessionId: '550e8400-e29b-41d4-a716-446655440001',
      });
      const crossSession = await reader.explainSearchByCosine(embedding, 10);

      // The sort on (distance, content_hash) is in both plans: ADR 0006 is why
      // the HNSW index cannot serve it.
      expect(scoped.join('\n')).toMatch(/Sort/);
      expect(scoped.join('\n')).toMatch(/session_id/);
      expect(crossSession.join('\n')).toMatch(/Sort/);
      expect(crossSession.join('\n')).not.toMatch(/session_id/);
    });
  });
});
