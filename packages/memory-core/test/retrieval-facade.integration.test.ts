import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ZodError } from 'zod';
import pg from 'pg';
import { PgPgvectorWriter } from '../src/semantic/pgvector/pgvector.writer.js';
import { PgPgvectorReader } from '../src/semantic/pgvector/pgvector.reader.js';
import { VectorRetrievalFacade } from '../src/semantic/retrieval-facade.js';
import { EMBEDDING_DIMENSIONS } from '../src/semantic/embedding.js';
import { runMigrations } from '../src/migrate.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const DATABASE_URL = process.env['DATABASE_URL'];

const SKIP = skipUnlessIntegrationEnv('VectorRetrievalFacade (integration)', 'DATABASE_URL');

describe.skipIf(SKIP)('VectorRetrievalFacade (integration)', () => {
  let pgPool: pg.Pool;
  let facade: VectorRetrievalFacade;
  let pgReader: PgPgvectorReader;

  beforeAll(async () => {
    pgPool = new pg.Pool({ connectionString: DATABASE_URL });

    await runMigrations(pgPool);

    // Clear prior test data
    await pgPool.query('DELETE FROM semantic_facts');

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
      text: 'Semantic memory is one pgvector index.',
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

    pgReader = new PgPgvectorReader(pgPool);
    facade = new VectorRetrievalFacade(pgReader);
  });

  afterAll(async () => {
    await pgPool.end();
  });

  const sessionA = '550e8400-e29b-41d4-a716-446655440001';
  const queryEmbedding = new Array(EMBEDDING_DIMENSIONS)
    .fill(0)
    .map((_, i) => Math.sin((i + 1) * 0.01));

  it('returns the vector reader’s list for the session', async () => {
    const results = await facade.retrieve({ queryEmbedding, topK: 10, sessionId: sessionA });
    const direct = await pgReader.searchByCosine(queryEmbedding, 10, { sessionId: sessionA });

    expect(results.length).toBeGreaterThan(0);
    expect(results).toEqual(direct);
    expect(new Set(results.map((r) => r.source))).toEqual(new Set(['pgvector']));
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

    it('refuses a query that names no session and does not opt out', async () => {
      // Before P4-B's M2 this read every session, the other session's fact included.
      await expect(facade.retrieve({ queryEmbedding })).rejects.toThrow(ZodError);
    });
  });

  it('returns cosine scores in monotonically decreasing order', async () => {
    const results = await facade.retrieve({ queryEmbedding, topK: 10, sessionId: sessionA });

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });
});
