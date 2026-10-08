import type { Driver } from 'neo4j-driver';
import { getTracer } from '@repo/telemetry';
import { GEN_AI, GEN_AI_OPERATION } from '@repo/telemetry/genai';
import type { RetrievalCandidate } from '../retrieval-facade.js';

const tracer = getTracer('memory-core');

/**
 * `gen_ai.operation.name` on this file's spans. The span names predate the
 * conventions and stay; the operation is the part a GenAI-aware backend reads.
 */
const SEARCH = {
  attributes: { [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.SEARCH_MEMORY },
};

/**
 * The session a graph read is confined to. Required, and with no
 * `crossSession` escape: every fact returned is one the session owns, and
 * every edge crossed is one it wrote (P2-D's M1).
 */
export interface GraphReadScope {
  readonly sessionId: string;
}

export interface Neo4jReader {
  expandFromSeeds(
    seedEntityIds: string[],
    hopDepth: number,
    scope: GraphReadScope,
  ): Promise<RetrievalCandidate[]>;
}

/**
 * Facts reachable in the knowledge graph from a set of seed concepts, scored
 * by hop distance alone.
 *
 * Not on any request path. ADR 0009 took the graph out of retrieval after
 * P2-B's ablation, and `MemoryModule` no longer constructs this class. It is
 * kept in `memory-core`, and not deleted with the fusion, for two callers: the
 * ablation runner, which reproduces the measurement that decided ADR 0002, and
 * P2-D, whose explanation measurement reads the graph. It is scoped to one
 * session, as P4-B's M1 specified and P2-D extended to edges: the facts it
 * returns are the session's own, reached over `RELATES_TO` and `MENTIONS`
 * edges the session wrote. P2-B's corpus is one session, so the scope leaves
 * the ablation's numbers as they were.
 */
export class CypherNeo4jReader implements Neo4jReader {
  constructor(private readonly driver: Driver) {}

  async expandFromSeeds(
    seedEntityIds: string[],
    hopDepth: number,
    scope: GraphReadScope,
  ): Promise<RetrievalCandidate[]> {
    return tracer.startActiveSpan('memory.neo4j.expand', SEARCH, async (span) => {
      try {
        span.setAttribute('seedEntityCount', seedEntityIds.length);
        span.setAttribute('hopDepth', hopDepth);

        if (seedEntityIds.length === 0) {
          span.setAttribute('resultCount', 0);
          return [];
        }

        const session = this.driver.session();
        try {
          // Bounded multi-hop traversal from the seed concepts to the facts
          // that mention them. The traversal is over :Concept — that is where
          // the relational structure is — but what comes back is a :Fact, so
          // this list and pgvector's describe the same kind of thing and RRF
          // has one universe to fuse over. `*0..n` lets a fact attached
          // directly to a seed count; the MENTIONS hop puts it at distance 1.
          //
          // contentHash is the tiebreaker because score is not one: every fact
          // at the same hop distance gets the identical `1.0 / (1.0 + distance)`
          // and `ORDER BY score DESC` alone leaves the rest to the store. It is
          // unique — the :Fact(contentHash) constraint says so — so the order is
          // total, and it is the same key pgvector's reader and rrfMerge use.
          //
          // The scope covers every relationship on the path, `MENTIONS`
          // included, as well as the fact: an edge another session wrote is
          // not a way into this session's facts.
          const result = await session.run(
            `MATCH path = (seed:Concept)-[:RELATES_TO*0..${Math.min(hopDepth, 3)}]-(related:Concept)
                          <-[:MENTIONS]-(f:Fact)
             WHERE seed.id IN $seedIds
               AND f.sessionId = $sessionId
               AND all(r IN relationships(path) WHERE r.sessionId = $sessionId)
             WITH f, min(length(path)) AS distance
             RETURN DISTINCT f.contentHash AS contentHash,
                    f.text AS text,
                    f.episodeId AS episodeId,
                    distance,
                    1.0 / (1.0 + distance) AS score
             ORDER BY score DESC, contentHash
             LIMIT 50`,
            { seedIds: seedEntityIds, sessionId: scope.sessionId },
          );

          const candidates: RetrievalCandidate[] = result.records.map((record) => ({
            source: 'neo4j' as const,
            score: record.get('score') as number,
            content: record.get('text') as string,
            contentHash: record.get('contentHash') as string,
            episodeId: (record.get('episodeId') as string | null) ?? undefined,
          }));

          span.setAttribute('resultCount', candidates.length);
          return candidates;
        } finally {
          await session.close();
        }
      } finally {
        span.end();
      }
    });
  }
}
