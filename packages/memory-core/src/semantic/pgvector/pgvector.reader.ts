import type pg from 'pg';
import { getTracer } from '@repo/telemetry';
import { toSql } from 'pgvector';
import type { RetrievalCandidate } from '../retrieval-facade.js';

const tracer = getTracer('memory-core');

export interface PgvectorSearchScope {
  /** Restricts the search to one session unless `crossSession` is set. */
  sessionId?: string | undefined;
  /** Opts out of session isolation for long-term semantic recall. */
  crossSession?: boolean | undefined;
}

export interface PgvectorReader {
  searchByCosine(
    queryEmbedding: number[],
    topK: number,
    scope?: PgvectorSearchScope,
  ): Promise<RetrievalCandidate[]>;
}

export class PgPgvectorReader implements PgvectorReader {
  constructor(private readonly pool: pg.Pool) {}

  async searchByCosine(
    queryEmbedding: number[],
    topK: number,
    scope: PgvectorSearchScope = {},
  ): Promise<RetrievalCandidate[]> {
    return tracer.startActiveSpan('memory.pgvector.search', async (span) => {
      try {
        span.setAttribute('topK', topK);
        span.setAttribute('queryLength', queryEmbedding.length);

        // Session isolation is the default. The alternative default leaks one
        // session's facts into another's context, which is what a missing
        // WHERE clause was doing. `crossSession` is the explicit opt-out for
        // long-term recall — P2-B's ablation needs it, because a store that
        // can only see the current session cannot demonstrate long-term
        // memory. The real boundary is a tenant; this repository has no tenant
        // concept yet, so the choice is made visible at the call site instead.
        const scoped = scope.sessionId !== undefined && scope.crossSession !== true;
        span.setAttribute('crossSession', !scoped);

        // content_hash is the secondary sort key in both variants, and both is
        // the point — the two strings differ only in the WHERE clause, so a
        // tiebreaker added to one of them is a tiebreaker the other silently
        // lacks. Cosine distance is not a total order over this table: the eval
        // harness seeds every fact in a task with one vector, and identical
        // vectors are at identical distance from any query. content_hash is the
        // primary key, so ordering on it after the distance is total, and it is
        // the key the Neo4j reader breaks its own tie on and rrfMerge fuses on.
        const result = await this.pool.query(
          scoped
            ? `SELECT content_hash, text, episode_id,
                      1 - (embedding <=> $1::vector) AS score
               FROM semantic_facts
               WHERE session_id = $3
               ORDER BY embedding <=> $1::vector, content_hash
               LIMIT $2`
            : `SELECT content_hash, text, episode_id,
                      1 - (embedding <=> $1::vector) AS score
               FROM semantic_facts
               ORDER BY embedding <=> $1::vector, content_hash
               LIMIT $2`,
          scoped ? [toSql(queryEmbedding), topK, scope.sessionId] : [toSql(queryEmbedding), topK],
        );

        const candidates: RetrievalCandidate[] = result.rows.map(
          (row: { content_hash: string; text: string; score: number; episode_id: string }) => ({
            source: 'pgvector' as const,
            score: row.score,
            content: row.text,
            // The query has always selected content_hash; returning it is what
            // lets RRF recognise a fact that both retrievers found.
            contentHash: row.content_hash,
            episodeId: row.episode_id,
          }),
        );

        span.setAttribute('resultCount', candidates.length);
        return candidates;
      } finally {
        span.end();
      }
    });
  }
}
