import { Module, Inject, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import type { Driver } from 'neo4j-driver';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createLogger } from '@repo/telemetry';
import {
  runMigrations,
  createPgvectorPool,
  createNeo4jClient,
  ensureSemanticConstraints,
  DrizzleEpisodicRepository,
  CypherNeo4jWriter,
  PgPgvectorWriter,
  PgPgvectorReader,
  VectorRetrievalFacade,
  PgRunRecordRepository,
  type CaseRepository,
} from '@repo/memory-core';
import { readMemoryConfig, type MemoryConfig } from './memory.config.js';
import { selectAppealRepository, selectCaseRepository } from './case-repository.js';
import {
  MEMORY_CONFIG,
  PG_POOL,
  NEO4J_DRIVER,
  EPISODIC_REPOSITORY,
  NEO4J_WRITER,
  PGVECTOR_WRITER,
  RETRIEVAL_FACADE,
  CHECKPOINTER,
  RUN_RECORDS,
  CASE_REPOSITORY,
  APPEAL_REPOSITORY,
} from './memory.tokens.js';

const logger = createLogger('memory-module');

/**
 * The composition root for the memory tiers.
 *
 * `packages/memory-core` was a set of tested adapters with no caller: both
 * dependency sets in `RunsService` passed closures that returned `[]` and
 * wrote nothing, which is what eight rows of `docs/STATUS.md` recorded. This
 * module is what constructs them.
 *
 * Every provider resolves to `null` when the memory axis is unconfigured, so
 * the no-database path stays a first-class one. When it *is* configured,
 * nothing here falls back: a failed migration, an unreachable driver or a
 * failed checkpointer setup stops boot. Selecting no-op writers because a
 * configured database is missing is the defect this replaces, and it must not
 * come back as a runtime path.
 */
@Module({
  providers: [
    {
      provide: MEMORY_CONFIG,
      useFactory: (): MemoryConfig | null => readMemoryConfig(),
    },
    {
      provide: PG_POOL,
      inject: [MEMORY_CONFIG],
      useFactory: async (config: MemoryConfig | null): Promise<pg.Pool | null> => {
        if (!config) return null;
        // Boot order: connect, then migrate, then let anything else resolve.
        // A migration failure here fails the container's healthcheck, which is
        // the intended loud failure.
        const pool = await createPgvectorPool({
          connectionString: config.databaseUrl,
          // An idle client dropped by a restarting server must not end the
          // process; the next query reconnects or fails on its own.
          onError: (error) => logger.warn({ msg: 'memory.postgres.idle_client_error', err: error }),
        });
        await runMigrations(pool);
        logger.info({ msg: 'memory.postgres.ready' });
        return pool;
      },
    },
    {
      provide: NEO4J_DRIVER,
      inject: [MEMORY_CONFIG],
      useFactory: async (config: MemoryConfig | null): Promise<Driver | null> => {
        if (!config) return null;
        const driver = createNeo4jClient({
          uri: config.neo4jUri,
          username: config.neo4jUser,
          password: config.neo4jPassword,
        });
        // Surfaces an unreachable Neo4j at boot rather than on the first run.
        await driver.verifyConnectivity();
        await ensureSemanticConstraints(driver);
        logger.info({ msg: 'memory.neo4j.ready' });
        return driver;
      },
    },
    {
      provide: EPISODIC_REPOSITORY,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool | null) =>
        pool ? new DrizzleEpisodicRepository(drizzle(pool)) : null,
    },
    {
      provide: NEO4J_WRITER,
      inject: [NEO4J_DRIVER],
      useFactory: (driver: Driver | null) => (driver ? new CypherNeo4jWriter(driver) : null),
    },
    {
      provide: PGVECTOR_WRITER,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool | null) => (pool ? new PgPgvectorWriter(pool) : null),
    },
    {
      // Vector-only (ADR 0009). The driver is still constructed above, because
      // `reflect` writes the graph; nothing on a request reads it.
      provide: RETRIEVAL_FACADE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool | null) =>
        pool ? new VectorRetrievalFacade(new PgPgvectorReader(pool)) : null,
    },
    {
      // The run record (P3-B): written beside the checkpoints by the same role,
      // and migrated with everything else above. Null on the unconfigured
      // axis, where nothing is recorded and there are no checkpoints either.
      provide: RUN_RECORDS,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool | null) => (pool ? new PgRunRecordRepository(pool) : null),
    },
    {
      provide: CHECKPOINTER,
      inject: [MEMORY_CONFIG, PG_POOL],
      useFactory: async (config: MemoryConfig | null, pool: pg.Pool | null) => {
        // PG_POOL is injected only to order this after the migration; the
        // saver owns its own connection and its own three tables.
        if (!config || !pool) return null;
        const saver = PostgresSaver.fromConnString(config.databaseUrl);
        await saver.setup();
        logger.info({ msg: 'memory.checkpointer.ready' });
        return saver;
      },
    },
    {
      // The prior-authorization case layer (P3-E, ADR 0010). Unlike every
      // provider above, it is never null: the unconfigured axis gets a
      // volatile in-process store and a warning, not a missing queue.
      provide: CASE_REPOSITORY,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool | null) =>
        selectCaseRepository(pool, (entry) => logger.warn(entry)),
    },
    {
      // Appeals (P3-F), over the case store above: on the unconfigured axis
      // the two share one per-case lock, so they must be the same instance.
      provide: APPEAL_REPOSITORY,
      inject: [PG_POOL, CASE_REPOSITORY],
      useFactory: (pool: pg.Pool | null, cases: CaseRepository) =>
        selectAppealRepository(pool, cases),
    },
  ],
  exports: [
    MEMORY_CONFIG,
    EPISODIC_REPOSITORY,
    NEO4J_WRITER,
    PGVECTOR_WRITER,
    RETRIEVAL_FACADE,
    CHECKPOINTER,
    RUN_RECORDS,
    CASE_REPOSITORY,
    APPEAL_REPOSITORY,
  ],
})
export class MemoryModule implements OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool | null,
    @Inject(NEO4J_DRIVER) private readonly driver: Driver | null,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.driver?.close();
    await this.pool?.end();
  }
}
