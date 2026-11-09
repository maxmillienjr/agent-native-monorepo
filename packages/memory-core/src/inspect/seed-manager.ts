import { z } from 'zod';
import type pg from 'pg';
import { getTracer } from '@repo/telemetry';
import { FactUpsertSchema, PgPgvectorWriter } from '../semantic/pgvector/pgvector.writer.js';

const tracer = getTracer('memory-core');

export const SeedStateSchema = z.object({
  sessionId: z.string().uuid(),
  /** `content_hash` values the seed owns in `semantic_facts`. */
  contentHashes: z.array(z.string()).default([]),
});
export type SeedState = z.input<typeof SeedStateSchema>;

/**
 * Restores a session to its seeded state between evaluation trials.
 *
 * Reset is not "empty the database". Postgres carries state across trials and
 * `reflect`'s writes are idempotent by content hash, so trial 2 of a task reads
 * trial 1's writes — but a truncate that also removes the seeds makes every
 * trial after the first a different task. What has to go is exactly what a
 * trial wrote.
 *
 * It is also load-bearing rather than tidy. `episodes` is keyed on
 * `(session_id, turn_index)` and first write wins, so without this the second
 * trial of a task writes no row at all and its `run_id` never appears — an
 * outcome grader keyed on the run would fail every trial after the first, for
 * a reason that has nothing to do with the agent.
 *
 * Both deletes are scoped to the session, so one task's reset leaves another
 * task's rows alone.
 *
 * The checkpointer's three tables are deliberately untouched: they are outside
 * `runMigrations`, `PostgresSaver.setup()` owns them, and each run mints a
 * fresh `thread_id`, so they accumulate rather than interfere.
 */
export const SeedApplicationSchema = z.object({
  /** The session whose state the seed is. */
  sessionId: z.string().uuid(),
  /** `semantic_facts` rows, each carrying its own session, as the table does. */
  facts: z.array(FactUpsertSchema).default([]),
});
export type SeedApplication = z.input<typeof SeedApplicationSchema>;

export interface SeedManager {
  /** Removes everything the seed does not own. */
  restoreToSeed(seed: SeedState): Promise<void>;
  /** Writes the seed back, through the same adapter production writes with. */
  applySeed(seed: SeedApplication): Promise<void>;
}

export class PgSeedManager implements SeedManager {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Lays down a task's seed state through `PgPgvectorWriter`, so a seeded row
   * is shaped exactly as one `reflect` writes.
   */
  async applySeed(seed: SeedApplication): Promise<void> {
    const validated = SeedApplicationSchema.parse(seed);

    return tracer.startActiveSpan('memory.inspect.applySeed', async (span) => {
      try {
        span.setAttribute('factCount', validated.facts.length);

        const pgvectorWriter = new PgPgvectorWriter(this.pool);
        for (const fact of validated.facts) await pgvectorWriter.upsertFact(fact);
      } finally {
        span.end();
      }
    });
  }

  async restoreToSeed(seed: SeedState): Promise<void> {
    const validated = SeedStateSchema.parse(seed);

    return tracer.startActiveSpan('memory.inspect.restoreToSeed', async (span) => {
      try {
        span.setAttribute('session_id', validated.sessionId);
        span.setAttribute('seedFactCount', validated.contentHashes.length);

        await this.pool.query('DELETE FROM episodes WHERE session_id = $1', [validated.sessionId]);
        await this.pool.query(
          'DELETE FROM semantic_facts WHERE session_id = $1 AND NOT (content_hash = ANY($2))',
          [validated.sessionId, validated.contentHashes],
        );
      } finally {
        span.end();
      }
    });
  }
}
