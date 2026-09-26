import { z } from 'zod';
import type pg from 'pg';
import { getTracer } from '@repo/telemetry';
import { GEN_AI, GEN_AI_OPERATION } from '@repo/telemetry/genai';
import { toSql } from 'pgvector';
import { EMBEDDING_DIMENSIONS } from '../embedding.js';

const tracer = getTracer('memory-core');

/**
 * `gen_ai.operation.name` on this file's spans. The span names predate the
 * conventions and stay; the operation is the part a GenAI-aware backend reads.
 */
const UPSERT = {
  attributes: { [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.UPSERT_MEMORY },
};

export const FactUpsertSchema = z.object({
  contentHash: z.string(),
  text: z.string(),
  embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
  episodeId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

export interface PgvectorWriter {
  upsertFact(fact: z.infer<typeof FactUpsertSchema>): Promise<void>;
}

export class PgPgvectorWriter implements PgvectorWriter {
  constructor(private readonly pool: pg.Pool) {}

  async upsertFact(fact: z.infer<typeof FactUpsertSchema>): Promise<void> {
    const validated = FactUpsertSchema.parse(fact);

    return tracer.startActiveSpan('memory.pgvector.upsert', UPSERT, async (span) => {
      try {
        span.setAttribute('fact.contentHash', validated.contentHash);

        await this.pool.query(
          `INSERT INTO semantic_facts (content_hash, text, embedding, episode_id, session_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (content_hash) DO UPDATE SET text = EXCLUDED.text`,
          [
            validated.contentHash,
            validated.text,
            toSql(validated.embedding),
            validated.episodeId,
            validated.sessionId,
          ],
        );
      } finally {
        span.end();
      }
    });
  }
}
