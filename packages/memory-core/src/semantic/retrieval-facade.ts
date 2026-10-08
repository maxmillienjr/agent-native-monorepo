import { z } from 'zod';
import { EMBEDDING_DIMENSIONS } from './embedding.js';
import type { PgvectorReader } from './pgvector/pgvector.reader.js';

export const RetrievalQuerySchema = z.object({
  queryEmbedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
  topK: z.number().int().positive().default(10),
  sessionId: z.string().uuid().optional(),
  /**
   * Opts out of session isolation. Retrieval is session-scoped by default;
   * this is for the case where long-term recall across sessions is the point.
   */
  crossSession: z.boolean().default(false),
});
export type RetrievalQuery = z.infer<typeof RetrievalQuerySchema>;
/**
 * What a caller passes. `topK` and `crossSession` carry defaults, so they are
 * required on the parsed value and optional on the way in.
 */
export type RetrievalQueryInput = z.input<typeof RetrievalQuerySchema>;

export const RetrievalCandidateSchema = z.object({
  /**
   * Which reader produced the candidate. A run only ever sees `pgvector`;
   * `neo4j` is what `CypherNeo4jReader` returns, to the P2-B ablation.
   */
  source: z.enum(['neo4j', 'pgvector']),
  score: z.number(),
  content: z.string(),
  /** sha256 of `content`, and the key both readers break a tied score on. */
  contentHash: z.string().optional(),
  entityId: z.string().optional(),
  episodeId: z.string().uuid().optional(),
});
export type RetrievalCandidate = z.infer<typeof RetrievalCandidateSchema>;

export interface RetrievalFacade {
  retrieve(query: RetrievalQueryInput): Promise<RetrievalCandidate[]>;
}

/**
 * Semantic retrieval for a run: one session-scoped cosine search over
 * `semantic_facts`, returned in the reader's order with the reader's scores.
 *
 * Vector-only by decision, not by omission. This facade used to read the
 * knowledge graph beside pgvector and fuse the two lists with Reciprocal Rank
 * Fusion (ADR 0002). P2-B measured that against pre-registered labels: on the
 * deployed path the graph list was empty for every query, so the fused list
 * equalled the vector list, and with perfect seeds fusion lowered Recall@10 by
 * 0.145. ADR 0009 took the graph out of the request path. `reflect` still
 * writes it, for an explanation role that P2-D measures or removes.
 *
 * It stays a facade, rather than `retrieve` calling the reader, because it is
 * where a query is validated and so where the session scope is decided.
 */
export class VectorRetrievalFacade implements RetrievalFacade {
  constructor(private readonly pgvectorReader: PgvectorReader) {}

  async retrieve(query: RetrievalQueryInput): Promise<RetrievalCandidate[]> {
    const validated = RetrievalQuerySchema.parse(query);
    return this.pgvectorReader.searchByCosine(validated.queryEmbedding, validated.topK, {
      sessionId: validated.sessionId,
      crossSession: validated.crossSession,
    });
  }
}
