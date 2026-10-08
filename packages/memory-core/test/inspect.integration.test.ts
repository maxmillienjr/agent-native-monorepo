import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import neo4j, { type Driver } from 'neo4j-driver';
import { PgNeo4jMemoryInspector } from '../src/inspect/run-inspector.js';
import { PgNeo4jSeedManager } from '../src/inspect/seed-manager.js';
import { DrizzleEpisodicRepository } from '../src/episodic/episodic.repo.js';
import { CypherNeo4jWriter } from '../src/semantic/neo4j/neo4j.writer.js';
import { CypherNeo4jReader } from '../src/semantic/neo4j/neo4j.reader.js';
import { PgPgvectorWriter } from '../src/semantic/pgvector/pgvector.writer.js';
import { EMBEDDING_DIMENSIONS, l2Normalize } from '../src/semantic/embedding.js';
import { runMigrations } from '../src/migrate.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';
import { drizzle } from 'drizzle-orm/node-postgres';

const DATABASE_URL = process.env['DATABASE_URL'];
const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'password';

const SKIP = skipUnlessIntegrationEnv(
  'memory inspection (integration)',
  'DATABASE_URL',
  'NEO4J_URI',
);

const SESSION = '550e8400-e29b-41d4-a716-4466554400a0';
const SEED_EPISODE = '550e8400-e29b-41d4-a716-4466554400a1';
const RUN = '550e8400-e29b-41d4-a716-4466554400a2';
const SECOND_RUN = '550e8400-e29b-41d4-a716-4466554400a3';

const SEED_CONCEPTS = ['inspect-seed-concept'];
const SEED_HASHES = ['inspect-seed-fact'];

const embedding = () => l2Normalize(new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => i + 1));

describe.skipIf(SKIP)('memory inspection (integration)', () => {
  let pool: pg.Pool;
  let driver: Driver;
  let inspector: PgNeo4jMemoryInspector;
  let reset: PgNeo4jSeedManager;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    driver = neo4j.driver(NEO4J_URI!, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
    await runMigrations(pool);
    inspector = new PgNeo4jMemoryInspector(pool, driver);
    reset = new PgNeo4jSeedManager(pool, driver);
  });

  afterAll(async () => {
    await driver.close();
    await pool.end();
  });

  /** Removes everything a previous trial left behind, then re-lays the seed. */
  async function seedAndReset(): Promise<void> {
    await reset.restoreToSeed({
      sessionId: SESSION,
      conceptIds: SEED_CONCEPTS,
      contentHashes: SEED_HASHES,
    });
    await reset.applySeed({
      sessionId: SESSION,
      concepts: [{ id: SEED_CONCEPTS[0]!, label: 'Seed Concept' }],
      relationships: [],
      facts: [
        {
          contentHash: SEED_HASHES[0]!,
          text: 'A seeded fact.',
          embedding: embedding(),
          episodeId: SEED_EPISODE,
          sessionId: SESSION,
        },
      ],
    });
  }

  async function writeAsRun(runId: string): Promise<void> {
    const repo = new DrizzleEpisodicRepository(drizzle(pool));
    await repo.write({
      sessionId: SESSION,
      runId,
      turnIndex: 0,
      role: 'user',
      content: 'What is LangGraph?',
    });
    await new CypherNeo4jWriter(driver).mergeEntity({ id: 'langgraph', label: 'LangGraph' });
    await new PgPgvectorWriter(pool).upsertFact({
      contentHash: `hash-${runId}`,
      text: `A fact written by ${runId}.`,
      embedding: embedding(),
      episodeId: runId,
      sessionId: SESSION,
    });
    await new CypherNeo4jWriter(driver).mergeFact({
      contentHash: `hash-${runId}`,
      text: `A fact written by ${runId}.`,
      episodeId: runId,
      sessionId: SESSION,
      entityIds: ['langgraph'],
    });
  }

  beforeEach(async () => {
    await seedAndReset();
  });

  it('counts what one run wrote, scoped to that run', async () => {
    await writeAsRun(RUN);

    const inspection = await inspector.inspectRun({ runId: RUN, conceptIds: ['langgraph'] });

    expect(inspection.episodeRowsForRun).toBe(1);
    expect(inspection.factRowsForRun).toBe(1);
    expect(inspection.factNodesForRun).toBe(1);
    expect(inspection.presentConceptIds).toEqual(['langgraph']);
  });

  it('reports a concept the run never merged as absent', async () => {
    await writeAsRun(RUN);

    const inspection = await inspector.inspectRun({
      runId: RUN,
      conceptIds: ['langgraph', 'never-extracted'],
    });

    expect(inspection.presentConceptIds).toEqual(['langgraph']);
  });

  it('restores the seed and removes what a trial wrote', async () => {
    await writeAsRun(RUN);
    await reset.restoreToSeed({
      sessionId: SESSION,
      conceptIds: SEED_CONCEPTS,
      contentHashes: SEED_HASHES,
    });

    const after = await inspector.inspectRun({ runId: RUN, conceptIds: ['langgraph'] });
    expect(after.episodeRowsForRun).toBe(0);
    expect(after.factRowsForRun).toBe(0);
    expect(after.factNodesForRun).toBe(0);
    expect(after.presentConceptIds).toEqual([]);

    // The seed itself survives. A reset that took it too would make every trial
    // after the first a different task.
    const seedRows = await pool.query('SELECT 1 FROM semantic_facts WHERE content_hash = $1', [
      SEED_HASHES[0],
    ]);
    expect(seedRows.rowCount).toBe(1);

    const seedConcept = await inspector.inspectRun({ runId: RUN, conceptIds: SEED_CONCEPTS });
    expect(seedConcept.presentConceptIds).toEqual(SEED_CONCEPTS);
  });

  it('re-applies a seed a previous task’s reset removed', async () => {
    // The Neo4j half of restoreToSeed is database-wide, because neither
    // :Concept nor :Fact carries a session. So another task's reset takes this
    // task's concepts with it, and only applySeed makes a two-task suite
    // repeatable.
    await reset.restoreToSeed({ sessionId: SESSION, conceptIds: [], contentHashes: [] });
    expect(
      (await inspector.inspectRun({ runId: SEED_EPISODE, conceptIds: SEED_CONCEPTS }))
        .presentConceptIds,
    ).toEqual([]);

    await seedAndReset();

    const restored = await inspector.inspectRun({
      runId: SEED_EPISODE,
      conceptIds: SEED_CONCEPTS,
    });
    expect(restored.presentConceptIds).toEqual(SEED_CONCEPTS);
    expect(restored.factRowsForRun).toBe(1);
  });

  it('lets a second trial write its own episodic row under its own run id', async () => {
    // Without the reset this is the failure that matters: `episodes` is keyed
    // on (session_id, turn_index) and first write wins, so trial 2 writes
    // nothing and its run id appears nowhere.
    await writeAsRun(RUN);
    await reset.restoreToSeed({
      sessionId: SESSION,
      conceptIds: SEED_CONCEPTS,
      contentHashes: SEED_HASHES,
    });
    await writeAsRun(SECOND_RUN);

    expect(
      (await inspector.inspectRun({ runId: SECOND_RUN, conceptIds: [] })).episodeRowsForRun,
    ).toBe(1);
    expect((await inspector.inspectRun({ runId: RUN, conceptIds: [] })).episodeRowsForRun).toBe(0);
  });

  describe('graph facts in a seed', () => {
    const GRAPH_CONCEPT = 'inspect-graph-concept';
    const GRAPH_HASH = 'inspect-graph-fact';

    async function applyGraphSeed(): Promise<void> {
      await reset.restoreToSeed({
        sessionId: SESSION,
        conceptIds: [...SEED_CONCEPTS, GRAPH_CONCEPT],
        contentHashes: [...SEED_HASHES, GRAPH_HASH],
      });
      await reset.applySeed({
        sessionId: SESSION,
        concepts: [
          { id: SEED_CONCEPTS[0]!, label: 'Seed Concept' },
          { id: GRAPH_CONCEPT, label: 'Graph Concept' },
        ],
        facts: [
          {
            contentHash: SEED_HASHES[0]!,
            text: 'A seeded fact.',
            embedding: embedding(),
            episodeId: SEED_EPISODE,
            sessionId: SESSION,
          },
        ],
        graphFacts: [
          {
            contentHash: GRAPH_HASH,
            text: 'A fact that only the graph holds.',
            episodeId: SEED_EPISODE,
            entityIds: [GRAPH_CONCEPT],
          },
        ],
      });
    }

    async function factHashes(): Promise<string[]> {
      const session = driver.session();
      try {
        const result = await session.run(
          'MATCH (f:Fact) RETURN f.contentHash AS hash ORDER BY hash',
        );
        return result.records.map((record) => record.get('hash') as string);
      } finally {
        await session.close();
      }
    }

    it('writes a graph fact the reader reaches from its concept at one hop', async () => {
      await applyGraphSeed();

      const found = await new CypherNeo4jReader(driver).expandFromSeeds([GRAPH_CONCEPT], 1, {
        sessionId: SESSION,
      });

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ source: 'neo4j', contentHash: GRAPH_HASH, score: 0.5 });
    });

    it('writes the graph fact to the graph only', async () => {
      await applyGraphSeed();

      const rows = await pool.query('SELECT 1 FROM semantic_facts WHERE content_hash = $1', [
        GRAPH_HASH,
      ]);
      expect(rows.rowCount).toBe(0);
    });

    it('leaves the same :Fact set after a second reset', async () => {
      await applyGraphSeed();
      const first = await factHashes();

      await writeAsRun(RUN);
      await applyGraphSeed();

      expect(await factHashes()).toEqual(first);
      expect(first).toContain(GRAPH_HASH);
    });
  });
});
