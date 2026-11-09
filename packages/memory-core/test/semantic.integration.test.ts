import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PgPgvectorWriter } from '../src/semantic/pgvector/pgvector.writer.js';
import { PgPgvectorReader } from '../src/semantic/pgvector/pgvector.reader.js';
import { EMBEDDING_DIMENSIONS } from '../src/semantic/embedding.js';
import { runMigrations } from '../src/migrate.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const DATABASE_URL = process.env['DATABASE_URL'];

const SKIP = skipUnlessIntegrationEnv('Semantic Memory (integration)', 'DATABASE_URL');

describe.skipIf(SKIP)('Semantic Memory (integration)', () => {
  let pgPool: pg.Pool;
  let pgWriter: PgPgvectorWriter;

  beforeAll(async () => {
    pgPool = new pg.Pool({ connectionString: DATABASE_URL });

    await runMigrations(pgPool);

    // Clear test data
    await pgPool.query('DELETE FROM semantic_facts');

    pgWriter = new PgPgvectorWriter(pgPool);
  });

  afterAll(async () => {
    await pgPool.end();
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
