import { z } from 'zod';
import type pg from 'pg';
import type { Driver } from 'neo4j-driver';
import { getTracer } from '@repo/telemetry';
import { CypherNeo4jWriter } from '../semantic/neo4j/neo4j.writer.js';
import { PgPgvectorWriter } from '../semantic/pgvector/pgvector.writer.js';
import {
  EntityWriteSchema,
  FactWriteSchema,
  RelationshipWriteSchema,
} from '../semantic/neo4j/neo4j.writer.js';
import { FactUpsertSchema } from '../semantic/pgvector/pgvector.writer.js';

const tracer = getTracer('memory-core');

export const SeedStateSchema = z.object({
  sessionId: z.string().uuid(),
  /** `:Concept` ids the seed owns. Everything else is a trial's leftovers. */
  conceptIds: z.array(z.string()).default([]),
  /** `content_hash` values the seed owns, in pgvector and in the graph. */
  contentHashes: z.array(z.string()).default([]),
});
export type SeedState = z.input<typeof SeedStateSchema>;

/**
 * Restores a session to its seeded state between evaluation trials.
 *
 * Reset is not "empty the database". Postgres and Neo4j carry state across
 * trials and `reflect`'s writes are idempotent by content hash, so trial 2 of
 * a task reads trial 1's writes — but a truncate that also removes the seeds
 * makes every trial after the first a different task. What has to go is
 * exactly what a trial wrote.
 *
 * It is also load-bearing rather than tidy. `episodes` is keyed on
 * `(session_id, turn_index)` and first write wins, so without this the second
 * trial of a task writes no row at all and its `run_id` never appears — an
 * outcome grader keyed on the run would fail every trial after the first, for
 * a reason that has nothing to do with the agent.
 *
 * **The Neo4j half is database-wide.** Neither `:Concept` nor `:Fact` carries a
 * session — `mergeEntity` writes an id, a label and a description, and nothing
 * else — so "everything this session's trials wrote" cannot be expressed in
 * Cypher. What can be expressed is "everything the seed does not own", and that
 * is what runs. Point an evaluation run at a disposable database.
 *
 * The checkpointer's three tables are deliberately untouched: they are outside
 * `runMigrations`, `PostgresSaver.setup()` owns them, and each run mints a
 * fresh `thread_id`, so they accumulate rather than interfere.
 */
export const SeedApplicationSchema = z.object({
  concepts: z.array(EntityWriteSchema).default([]),
  relationships: z.array(RelationshipWriteSchema.omit({ createdAt: true })).default([]),
  facts: z.array(FactUpsertSchema).default([]),
  /**
   * `:Fact` nodes and their `MENTIONS` edges, written through `mergeFact`.
   *
   * Without these a seed cannot reach the graph retriever at all:
   * `expandFromSeeds` returns facts reached through `MENTIONS`, and concepts
   * and `RELATES_TO` edges alone give it nothing to return. A graph fact is
   * independent of `facts` on purpose — a fact present in one index and absent
   * from the other is exactly what an ablation or a graph-path task needs.
   */
  graphFacts: z.array(FactWriteSchema).default([]),
});
export type SeedApplication = z.input<typeof SeedApplicationSchema>;

export interface SeedManager {
  /** Removes everything the seed does not own. */
  restoreToSeed(seed: SeedState): Promise<void>;
  /** Writes the seed back, through the same adapters production writes with. */
  applySeed(seed: SeedApplication): Promise<void>;
}

export class PgNeo4jSeedManager implements SeedManager {
  constructor(
    private readonly pool: pg.Pool,
    private readonly driver: Driver,
  ) {}

  /**
   * Lays down a task's seed state.
   *
   * Paired with `restoreToSeed` rather than left to a one-off script, because
   * the deletion half is database-wide on the Neo4j side and one task's reset
   * therefore removes another task's concepts. A suite with two tasks in it is
   * only repeatable if every reset also re-applies what it is resetting to.
   */
  async applySeed(seed: SeedApplication): Promise<void> {
    const validated = SeedApplicationSchema.parse(seed);

    return tracer.startActiveSpan('memory.inspect.applySeed', async (span) => {
      try {
        span.setAttribute('conceptCount', validated.concepts.length);
        span.setAttribute('relationshipCount', validated.relationships.length);
        span.setAttribute('factCount', validated.facts.length);
        span.setAttribute('graphFactCount', validated.graphFacts.length);

        const neo4jWriter = new CypherNeo4jWriter(this.driver);
        const pgvectorWriter = new PgPgvectorWriter(this.pool);

        for (const concept of validated.concepts) await neo4jWriter.mergeEntity(concept);
        for (const relationship of validated.relationships) {
          await neo4jWriter.mergeRelationship({ ...relationship, createdAt: new Date() });
        }
        for (const fact of validated.facts) await pgvectorWriter.upsertFact(fact);
        // After the concepts, and that order is load-bearing: `mergeFact` links
        // with `MATCH (c:Concept {id: eid})`, which matches nothing for a concept
        // not yet written and so drops the edge without an error.
        for (const fact of validated.graphFacts) await neo4jWriter.mergeFact(fact);
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
        span.setAttribute('seedConceptCount', validated.conceptIds.length);
        span.setAttribute('seedFactCount', validated.contentHashes.length);

        await this.pool.query('DELETE FROM episodes WHERE session_id = $1', [validated.sessionId]);
        await this.pool.query(
          'DELETE FROM semantic_facts WHERE session_id = $1 AND NOT (content_hash = ANY($2))',
          [validated.sessionId, validated.contentHashes],
        );

        const session = this.driver.session();
        try {
          await session.run('MATCH (f:Fact) WHERE NOT f.contentHash IN $keep DETACH DELETE f', {
            keep: validated.contentHashes,
          });
          await session.run('MATCH (c:Concept) WHERE NOT c.id IN $keep DETACH DELETE c', {
            keep: validated.conceptIds,
          });
        } finally {
          await session.close();
        }
      } finally {
        span.end();
      }
    });
  }
}
