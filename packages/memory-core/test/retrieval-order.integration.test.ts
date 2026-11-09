import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PgPgvectorWriter } from '../src/semantic/pgvector/pgvector.writer.js';
import { PgPgvectorReader } from '../src/semantic/pgvector/pgvector.reader.js';
import { EMBEDDING_DIMENSIONS } from '../src/semantic/embedding.js';
import { runMigrations } from '../src/migrate.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const DATABASE_URL = process.env['DATABASE_URL'];

const SKIP = skipUnlessIntegrationEnv(
  'Retrieval ordering determinism (integration)',
  'DATABASE_URL',
);

const EPISODE_ID = '550e8400-e29b-41d4-a716-4466554400c0';
const SESSION_ID = '550e8400-e29b-41d4-a716-4466554400c1';
const OTHER_SESSION_ID = '550e8400-e29b-41d4-a716-4466554400c2';

/**
 * Twelve facts, written in an order that is deliberately not their sorted
 * order. A tiebreaker that works produces the sorted sequence; a suite that
 * happened to seed in sorted order could not tell that apart from a store that
 * simply returns rows in insertion order.
 */
const WRITE_ORDER = [
  'sha256-order-07',
  'sha256-order-00',
  'sha256-order-11',
  'sha256-order-04',
  'sha256-order-09',
  'sha256-order-02',
  'sha256-order-06',
  'sha256-order-01',
  'sha256-order-10',
  'sha256-order-03',
  'sha256-order-08',
  'sha256-order-05',
] as const;

const SORTED_ORDER = [...WRITE_ORDER].sort();

/** The number of delete-and-reseed cycles the PRD's probe used. */
const CYCLES = 3;

describe.skipIf(SKIP)('Retrieval ordering determinism (integration)', () => {
  let pgPool: pg.Pool;
  let pgWriter: PgPgvectorWriter;
  let pgReader: PgPgvectorReader;

  /**
   * One vector for every fact. `AgentServiceHarness.reset` seeds each task's
   * facts with `fixtureEmbedding()` and no argument, so every seeded fact in a
   * task carries the same vector — this reproduces that, which is the case
   * where the cosine distance is equal for every row and the ordering rests
   * entirely on the secondary key.
   */
  const embedding = new Array<number>(EMBEDDING_DIMENSIONS)
    .fill(0)
    .map((_, i) => Math.sin(i * 0.01));

  async function clearStores(): Promise<void> {
    await pgPool.query('DELETE FROM semantic_facts');
  }

  /**
   * Recreates the identical dataset from scratch — the delete-and-reseed a
   * trial reset performs.
   *
   * The facts are written concurrently, so the order the store holds them in
   * is unconstrained, which is the property the ordering must not depend on.
   * A sequential fixture can pass against an untied query by returning rows
   * in write order.
   */
  async function reseed(): Promise<void> {
    await clearStores();

    await Promise.all(
      WRITE_ORDER.map(async (contentHash) => {
        const text = `Fact ${contentHash}, at the same distance as every other.`;

        await pgWriter.upsertFact({
          contentHash,
          text,
          embedding,
          episodeId: EPISODE_ID,
          sessionId: SESSION_ID,
        });
      }),
    );
  }

  beforeAll(async () => {
    pgPool = new pg.Pool({ connectionString: DATABASE_URL });

    await runMigrations(pgPool);

    pgWriter = new PgPgvectorWriter(pgPool);
    pgReader = new PgPgvectorReader(pgPool);

    await reseed();
  });

  afterAll(async () => {
    await clearStores();
    await pgPool.end();
  });

  describe('searchByCosine', () => {
    it('scores every fact carrying the same vector identically', async () => {
      // The premise of the whole suite. If the scores were distinct the order
      // would be determined by distance alone and the secondary key would
      // never be consulted, so a passing determinism test would prove nothing.
      const candidates = await pgReader.searchByCosine(embedding, WRITE_ORDER.length);

      expect(candidates).toHaveLength(WRITE_ORDER.length);
      expect(new Set(candidates.map((c) => c.score)).size).toBe(1);
    });

    it(`returns the same order across ${CYCLES} delete-and-reseed cycles`, async () => {
      const orders: string[][] = [];
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        await reseed();
        const candidates = await pgReader.searchByCosine(embedding, WRITE_ORDER.length);
        orders.push(candidates.map((c) => c.contentHash));
      }

      for (const order of orders) {
        expect(order).toEqual(orders[0]);
      }
    });

    it('breaks the tie on content_hash in both query variants', async () => {
      // Two SQL strings, one per scope, and only one of them is on the path a
      // run takes by default. Both need the secondary key or a cassette
      // recorded through `crossSession` replays against an unordered query.
      const scoped = await pgReader.searchByCosine(embedding, WRITE_ORDER.length, {
        sessionId: SESSION_ID,
      });
      const crossSession = await pgReader.searchByCosine(embedding, WRITE_ORDER.length, {
        sessionId: OTHER_SESSION_ID,
        crossSession: true,
      });

      expect(scoped.map((c) => c.contentHash)).toEqual(SORTED_ORDER);
      expect(crossSession.map((c) => c.contentHash)).toEqual(SORTED_ORDER);
    });
  });
});
