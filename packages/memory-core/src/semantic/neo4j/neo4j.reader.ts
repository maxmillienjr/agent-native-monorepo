import type { Driver } from 'neo4j-driver';
import { getTracer } from '@repo/telemetry';
import type { RetrievalCandidate } from '../retrieval-facade.js';

const tracer = getTracer('memory-core');

export interface Neo4jReader {
  expandFromSeeds(seedEntityIds: string[], hopDepth: number): Promise<RetrievalCandidate[]>;
}

export class CypherNeo4jReader implements Neo4jReader {
  constructor(private readonly driver: Driver) {}

  async expandFromSeeds(seedEntityIds: string[], hopDepth: number): Promise<RetrievalCandidate[]> {
    return tracer.startActiveSpan('memory.neo4j.expand', async (span) => {
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
          const result = await session.run(
            `MATCH path = (seed:Concept)-[:RELATES_TO*0..${Math.min(hopDepth, 3)}]-(related:Concept)
                          <-[:MENTIONS]-(f:Fact)
             WHERE seed.id IN $seedIds
             WITH f, min(length(path)) AS distance
             RETURN DISTINCT f.contentHash AS contentHash,
                    f.text AS text,
                    f.episodeId AS episodeId,
                    distance,
                    1.0 / (1.0 + distance) AS score
             ORDER BY score DESC, contentHash
             LIMIT 50`,
            { seedIds: seedEntityIds },
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
