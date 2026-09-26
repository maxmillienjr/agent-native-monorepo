import type pg from 'pg';
import { getTracer } from '@repo/telemetry';
import { GEN_AI, GEN_AI_OPERATION } from '@repo/telemetry/genai';
import { toSql } from 'pgvector';
import type { RetrievalCandidate } from '../retrieval-facade.js';

const tracer = getTracer('memory-core');

/**
 * `gen_ai.operation.name` on this file's spans. The span names predate the
 * conventions and stay; the operation is the part a GenAI-aware backend reads.
 */
const SEARCH = {
  attributes: { [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.SEARCH_MEMORY },
};

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

const isScoped = (scope: PgvectorSearchScope): boolean =>
  scope.sessionId !== undefined && scope.crossSession !== true;

/**
 * The one statement `searchByCosine` runs, as text and parameters.
 *
 * Built in one place so that `explainSearchByCosine` plans exactly the query
 * the reader executes: a plan of a hand-copied string is a plan of a query
 * nobody runs.
 */
function cosineSearch(
  queryEmbedding: number[],
  topK: number,
  scope: PgvectorSearchScope,
): [string, unknown[]] {
  // content_hash is the secondary sort key in both variants, and both is
  // the point — the two strings differ only in the WHERE clause, so a
  // tiebreaker added to one of them is a tiebreaker the other silently
  // lacks. Cosine distance is not a total order over this table: the eval
  // harness seeds every fact in a task with one vector, and identical
  // vectors are at identical distance from any query. content_hash is the
  // primary key, so ordering on it after the distance is total, and it is
  // the key the Neo4j reader breaks its own tie on and rrfMerge fuses on.
  return isScoped(scope)
    ? [
        `SELECT content_hash, text, episode_id,
                1 - (embedding <=> $1::vector) AS score
         FROM semantic_facts
         WHERE session_id = $3
         ORDER BY embedding <=> $1::vector, content_hash
         LIMIT $2`,
        [toSql(queryEmbedding), topK, scope.sessionId],
      ]
    : [
        `SELECT content_hash, text, episode_id,
                1 - (embedding <=> $1::vector) AS score
         FROM semantic_facts
         ORDER BY embedding <=> $1::vector, content_hash
         LIMIT $2`,
        [toSql(queryEmbedding), topK],
      ];
}

export class PgPgvectorReader implements PgvectorReader {
  constructor(private readonly pool: pg.Pool) {}

  async searchByCosine(
    queryEmbedding: number[],
    topK: number,
    scope: PgvectorSearchScope = {},
  ): Promise<RetrievalCandidate[]> {
    return tracer.startActiveSpan('memory.pgvector.search', SEARCH, async (span) => {
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
        span.setAttribute('crossSession', !isScoped(scope));

        const result = await this.pool.query(...cosineSearch(queryEmbedding, topK, scope));

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

  /**
   * The planner's plan for exactly the statement `searchByCosine` runs.
   *
   * Not a hot-path method. It exists so a report can say, from the database
   * rather than from a comment, whether the search is served by the HNSW index
   * or by a sequential scan — ADR 0006 records why it is the latter.
   *
   * `COSTS OFF` because the question is the plan's shape. The estimates move
   * with table statistics, which autovacuum refreshes on its own schedule, so
   * a plan with costs in it differs between two runs over identical rows.
   *
   * It analyzes the table first for the same reason. Measured on 2026-09-26
   * over 335 freshly written rows in one session: the same query planned as a
   * sequential scan before autovacuum's analyze had run and as a `session_id`
   * bitmap scan after it. Neither uses the HNSW index, but a plan that depends
   * on whether a background worker has woken up is not something a report can
   * print as a property of the query.
   */
  async explainSearchByCosine(
    queryEmbedding: number[],
    topK: number,
    scope: PgvectorSearchScope = {},
  ): Promise<string[]> {
    const [text, params] = cosineSearch(queryEmbedding, topK, scope);
    await this.pool.query('ANALYZE semantic_facts');
    const result = await this.pool.query(`EXPLAIN (COSTS OFF) ${text}`, params);
    return result.rows.map((row: { 'QUERY PLAN': string }) => row['QUERY PLAN']);
  }
}
