import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { Ledger, PgLedgerStore, assertWriterRole, createLedgerPool } from '@repo/decision-ledger';
import type { RunRecordRepository } from '@repo/memory-core';
import { createLogger } from '@repo/telemetry';
import { MemoryModule } from '../memory/memory.module.js';
import type { MemoryConfig } from '../memory/memory.config.js';
import { CHECKPOINTER, MEMORY_CONFIG, RUN_RECORDS } from '../memory/memory.tokens.js';
import { readLedgerConfig, type LedgerConfig } from './ledger.config.js';
import { RunLedger } from './run-ledger.js';
import { LEDGER_CONFIG, LEDGER_POOL, RUN_LEDGER } from './ledger.tokens.js';

const logger = createLogger('ledger-module');

/**
 * The ledger axis (P3-C). `null` everywhere when `LEDGER_DATABASE_URL` is
 * unset. When it is set, boot fails rather than falls back:
 *
 * - without the memory axis, because the ledger commits to run records and
 *   there are none to commit to;
 * - on an unreachable database (the connect in `assertWriterRole`);
 * - on a database with no ledger tables (`yarn ledger:migrate` first);
 * - on a role that holds `UPDATE`, `DELETE`, `TRUNCATE` or ownership of
 *   `ledger_entries`, because a ledger its writer can rewrite proves nothing
 *   about the writer.
 */
@Module({
  imports: [MemoryModule],
  providers: [
    { provide: LEDGER_CONFIG, useFactory: (): LedgerConfig | null => readLedgerConfig() },
    {
      provide: LEDGER_POOL,
      inject: [LEDGER_CONFIG, MEMORY_CONFIG],
      useFactory: async (
        config: LedgerConfig | null,
        memory: MemoryConfig | null,
      ): Promise<pg.Pool | null> => {
        if (config === null) {
          logger.info({ msg: 'ledger.unconfigured' });
          return null;
        }
        if (memory === null) {
          throw new Error(
            'LEDGER_DATABASE_URL is set but memory is not: the ledger commits to run records, ' +
              'which exist only on the memory axis. Set DATABASE_URL and NEO4J_URI too, or unset it.',
          );
        }
        // Short timeouts and an error listener: a ledger that stops answering
        // must not hold a run or crash the service. The chat path logs and
        // answers; the decision paths answer 503.
        const pool = createLedgerPool(config.databaseUrl, {
          onError: (error) => logger.warn({ msg: 'ledger.pool.error', error: error.message }),
        });
        try {
          await assertWriterRole(pool);
        } catch (error) {
          await pool.end();
          throw error;
        }
        logger.info({ msg: 'ledger.ready' });
        return pool;
      },
    },
    {
      provide: RUN_LEDGER,
      inject: [LEDGER_POOL, RUN_RECORDS, CHECKPOINTER],
      useFactory: (
        pool: pg.Pool | null,
        records: RunRecordRepository | null,
        checkpointer: BaseCheckpointSaver | null,
      ): RunLedger | null =>
        pool === null || records === null || checkpointer === null
          ? null
          : new RunLedger(new Ledger(new PgLedgerStore(pool)), records, checkpointer),
    },
  ],
  exports: [RUN_LEDGER],
})
export class LedgerModule implements OnModuleDestroy {
  constructor(@Inject(LEDGER_POOL) private readonly pool: pg.Pool | null) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
