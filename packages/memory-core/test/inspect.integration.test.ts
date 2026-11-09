import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { PgMemoryInspector } from '../src/inspect/run-inspector.js';
import { PgSeedManager } from '../src/inspect/seed-manager.js';
import { DrizzleEpisodicRepository } from '../src/episodic/episodic.repo.js';
import { PgPgvectorWriter } from '../src/semantic/pgvector/pgvector.writer.js';
import { EMBEDDING_DIMENSIONS, l2Normalize } from '../src/semantic/embedding.js';
import { runMigrations } from '../src/migrate.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';
import { drizzle } from 'drizzle-orm/node-postgres';

const DATABASE_URL = process.env['DATABASE_URL'];

const SKIP = skipUnlessIntegrationEnv('memory inspection (integration)', 'DATABASE_URL');

const SESSION = '550e8400-e29b-41d4-a716-4466554400a0';
const SEED_EPISODE = '550e8400-e29b-41d4-a716-4466554400a1';
const RUN = '550e8400-e29b-41d4-a716-4466554400a2';
const SECOND_RUN = '550e8400-e29b-41d4-a716-4466554400a3';
const OTHER_SESSION = '550e8400-e29b-41d4-a716-4466554400a4';

const SEED_HASHES = ['inspect-seed-fact'];

const embedding = () => l2Normalize(new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => i + 1));

describe.skipIf(SKIP)('memory inspection (integration)', () => {
  let pool: pg.Pool;
  let inspector: PgMemoryInspector;
  let reset: PgSeedManager;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await runMigrations(pool);
    inspector = new PgMemoryInspector(pool);
    reset = new PgSeedManager(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Removes everything a previous trial left behind, then re-lays the seed. */
  async function seedAndReset(): Promise<void> {
    await reset.restoreToSeed({
      sessionId: SESSION,
      contentHashes: SEED_HASHES,
    });
    await reset.applySeed({
      sessionId: SESSION,
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

  async function writeAsRun(runId: string, sessionId: string = SESSION): Promise<void> {
    const repo = new DrizzleEpisodicRepository(drizzle(pool));
    await repo.write({
      sessionId,
      runId,
      turnIndex: 0,
      role: 'user',
      content: 'What is LangGraph?',
    });
    await new PgPgvectorWriter(pool).upsertFact({
      contentHash: `hash-${runId}`,
      text: `A fact written by ${runId}.`,
      embedding: embedding(),
      episodeId: runId,
      sessionId,
    });
  }

  beforeEach(async () => {
    await seedAndReset();
  });

  it('counts what one run wrote, scoped to that run', async () => {
    await writeAsRun(RUN);

    const inspection = await inspector.inspectRun({ runId: RUN });

    expect(inspection.episodeRowsForRun).toBe(1);
    expect(inspection.factRowsForRun).toBe(1);
  });

  it('restores the seed and removes what a trial wrote', async () => {
    await writeAsRun(RUN);
    await reset.restoreToSeed({ sessionId: SESSION, contentHashes: SEED_HASHES });

    const after = await inspector.inspectRun({ runId: RUN });
    expect(after.episodeRowsForRun).toBe(0);
    expect(after.factRowsForRun).toBe(0);

    // The seed itself survives. A reset that took it too would make every trial
    // after the first a different task.
    const seedRows = await pool.query('SELECT 1 FROM semantic_facts WHERE content_hash = $1', [
      SEED_HASHES[0],
    ]);
    expect(seedRows.rowCount).toBe(1);
  });

  it('re-applies a seed that a reset owning nothing removed', async () => {
    await reset.restoreToSeed({ sessionId: SESSION, contentHashes: [] });
    expect((await inspector.inspectRun({ runId: SEED_EPISODE })).factRowsForRun).toBe(0);

    await seedAndReset();

    expect((await inspector.inspectRun({ runId: SEED_EPISODE })).factRowsForRun).toBe(1);
  });

  it('leaves another session’s rows alone', async () => {
    await reset.restoreToSeed({ sessionId: OTHER_SESSION, contentHashes: [] });
    await writeAsRun(SECOND_RUN, OTHER_SESSION);
    await reset.restoreToSeed({ sessionId: SESSION, contentHashes: SEED_HASHES });

    const other = await inspector.inspectRun({ runId: SECOND_RUN });
    expect(other.episodeRowsForRun).toBe(1);
    expect(other.factRowsForRun).toBe(1);

    await reset.restoreToSeed({ sessionId: OTHER_SESSION, contentHashes: [] });
  });

  it('lets a second trial write its own episodic row under its own run id', async () => {
    // Without the reset this is the failure that matters: `episodes` is keyed
    // on (session_id, turn_index) and first write wins, so trial 2 writes
    // nothing and its run id appears nowhere.
    await writeAsRun(RUN);
    await reset.restoreToSeed({ sessionId: SESSION, contentHashes: SEED_HASHES });
    await writeAsRun(SECOND_RUN);

    expect((await inspector.inspectRun({ runId: SECOND_RUN })).episodeRowsForRun).toBe(1);
    expect((await inspector.inspectRun({ runId: RUN })).episodeRowsForRun).toBe(0);
  });
});
