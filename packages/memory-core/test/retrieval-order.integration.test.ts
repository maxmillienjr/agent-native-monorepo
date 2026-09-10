import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j, { type Driver } from 'neo4j-driver';
import pg from 'pg';
import { CypherNeo4jWriter } from '../src/semantic/neo4j/neo4j.writer.js';
import { CypherNeo4jReader } from '../src/semantic/neo4j/neo4j.reader.js';
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

const SKIP = skipUnlessIntegrationEnv(
  'Retrieval ordering determinism (integration)',
  'DATABASE_URL',
  'NEO4J_URI',
);

const EPISODE_ID = '550e8400-e29b-41d4-a716-4466554400c0';
const SESSION_ID = '550e8400-e29b-41d4-a716-4466554400c1';
const OTHER_SESSION_ID = '550e8400-e29b-41d4-a716-4466554400c2';
const SEED_CONCEPT_ID = 'order-seed';

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
  let neo4jDriver: Driver;
  let pgPool: pg.Pool;
  let neo4jWriter: CypherNeo4jWriter;
  let pgWriter: PgPgvectorWriter;
  let neo4jReader: CypherNeo4jReader;
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
    const session = neo4jDriver.session();
    try {
      await session.run('MATCH (n) DETACH DELETE n');
    } finally {
      await session.close();
    }
    await pgPool.query('DELETE FROM semantic_facts');
  }

  /**
   * Recreates the identical dataset from scratch — the delete-and-reseed a
   * trial reset performs, and the sequence that made the graph query return a
   * different order every time for the same data.
   *
   * The facts are written concurrently, and that is load-bearing rather than a
   * shortcut. Seeded one at a time into an emptied store, Neo4j assigns the
   * twelve `:Fact` nodes their internal ids in write order and the untied query
   * returned them in exactly reverse write order on 30 consecutive cycles — so
   * a sequential fixture passes against the defect and proves nothing. Writing
   * them concurrently leaves id assignment unconstrained, which is the property
   * the ordering must not depend on: 20 concurrent cycles produced 20 distinct
   * orders before the tiebreaker was declared.
   */
  async function reseed(): Promise<void> {
    await clearStores();

    await neo4jWriter.mergeEntity({
      id: SEED_CONCEPT_ID,
      label: 'Ordering seed',
      description: 'Every fact in this fixture mentions it, and only it.',
    });

    await Promise.all(
      WRITE_ORDER.map(async (contentHash) => {
        const text = `Fact ${contentHash} at one hop from the seed concept.`;

        // Every fact hangs off the same seed concept by a single MENTIONS edge,
        // so all twelve sit at the same hop distance and `1.0 / (1.0 + distance)`
        // gives all twelve the same score. There is nothing left to order by.
        await neo4jWriter.mergeFact({
          contentHash,
          text,
          episodeId: EPISODE_ID,
          entityIds: [SEED_CONCEPT_ID],
        });

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
    neo4jDriver = neo4j.driver(NEO4J_URI!, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    pgPool = new pg.Pool({ connectionString: DATABASE_URL });

    await runMigrations(pgPool);
    await ensureSemanticConstraints(neo4jDriver);

    neo4jWriter = new CypherNeo4jWriter(neo4jDriver);
    pgWriter = new PgPgvectorWriter(pgPool);
    neo4jReader = new CypherNeo4jReader(neo4jDriver);
    pgReader = new PgPgvectorReader(pgPool);

    await reseed();
  });

  afterAll(async () => {
    await clearStores();
    await neo4jDriver.close();
    await pgPool.end();
  });

  describe('expandFromSeeds', () => {
    it('scores every fact at the same hop distance identically', async () => {
      // The premise of the whole suite. If the scores were distinct the order
      // would be determined by `score DESC` alone and the secondary key would
      // never be consulted, so a passing determinism test would prove nothing.
      const candidates = await neo4jReader.expandFromSeeds([SEED_CONCEPT_ID], 2);

      expect(candidates).toHaveLength(WRITE_ORDER.length);
      expect(new Set(candidates.map((c) => c.score)).size).toBe(1);
    });

    it(`returns the same order across ${CYCLES} delete-and-reseed cycles`, async () => {
      const orders: string[][] = [];
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        await reseed();
        const candidates = await neo4jReader.expandFromSeeds([SEED_CONCEPT_ID], 2);
        orders.push(candidates.map((c) => c.contentHash));
      }

      for (const order of orders) {
        expect(order).toEqual(orders[0]);
      }
    });

    it('breaks the tie on contentHash rather than on store order', async () => {
      // Written scrambled, read back sorted: the tie is broken by the declared
      // secondary key and not by whatever order the store happens to hold.
      const candidates = await neo4jReader.expandFromSeeds([SEED_CONCEPT_ID], 2);

      expect(candidates.map((c) => c.contentHash)).toEqual(SORTED_ORDER);
    });
  });

  describe('searchByCosine', () => {
    it('scores every fact carrying the same vector identically', async () => {
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
