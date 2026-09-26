import { z } from 'zod';
import type pg from 'pg';
import type { Driver } from 'neo4j-driver';
import { getTracer } from '@repo/telemetry';

const tracer = getTracer('memory-core');

export const RunInspectionInputSchema = z.object({
  /** `reflect` writes `run_id` on episodes and `episodeId` on facts. */
  runId: z.string().uuid(),
  /** The concept ids `distill` produced, to be looked for in the graph. */
  conceptIds: z.array(z.string()).default([]),
});
export type RunInspectionInput = z.input<typeof RunInspectionInputSchema>;

export interface RunInspection {
  readonly runId: string;
  readonly episodeRowsForRun: number;
  readonly factRowsForRun: number;
  readonly factNodesForRun: number;
  /** The subset of the requested ids a `:Concept` node exists for. */
  readonly presentConceptIds: string[];
}

/**
 * Reads back what one run persisted.
 *
 * It exists because the evaluation harness has to answer "did `reflect`
 * actually write the episode, MERGE the entity, upsert the fact" and there was
 * nothing to ask. `EpisodicRepository.findBySession` was the closest thing, and
 * a session is not a run.
 *
 * The alternative was a grader holding its own pool and its own SQL, and the
 * cost of that is on the record: the nightly seed script, since deleted, used
 * to hand-roll the schema it seeded into, which is how the eval fixtures ended
 * up in a table shaped differently from production's. A grader that drifts the
 * same way reports a false negative on the one signal evaluation exists to
 * produce.
 */
export interface MemoryInspector {
  inspectRun(input: RunInspectionInput): Promise<RunInspection>;
}

export class PgNeo4jMemoryInspector implements MemoryInspector {
  constructor(
    private readonly pool: pg.Pool,
    private readonly driver: Driver,
  ) {}

  async inspectRun(input: RunInspectionInput): Promise<RunInspection> {
    const validated = RunInspectionInputSchema.parse(input);

    return tracer.startActiveSpan('memory.inspect.run', async (span) => {
      try {
        span.setAttribute('run_id', validated.runId);

        const [episodes, facts] = await Promise.all([
          this.pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM episodes WHERE run_id = $1',
            [validated.runId],
          ),
          this.pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM semantic_facts WHERE episode_id = $1',
            [validated.runId],
          ),
        ]);

        const session = this.driver.session();
        try {
          const factNodes = await session.run(
            'MATCH (f:Fact {episodeId: $runId}) RETURN count(f) AS n',
            { runId: validated.runId },
          );
          const concepts = await session.run(
            'MATCH (c:Concept) WHERE c.id IN $ids RETURN c.id AS id',
            { ids: validated.conceptIds },
          );

          const inspection: RunInspection = {
            runId: validated.runId,
            episodeRowsForRun: Number(episodes.rows[0]?.n ?? 0),
            factRowsForRun: Number(facts.rows[0]?.n ?? 0),
            // Neo4j integers arrive as a {low, high} pair; toNumber is the
            // driver's own narrowing and is safe for a count.
            factNodesForRun: factNodes.records[0]?.get('n').toNumber() ?? 0,
            presentConceptIds: concepts.records.map((record) => record.get('id') as string),
          };

          span.setAttribute('episodeRowsForRun', inspection.episodeRowsForRun);
          span.setAttribute('factRowsForRun', inspection.factRowsForRun);
          span.setAttribute('factNodesForRun', inspection.factNodesForRun);
          return inspection;
        } finally {
          await session.close();
        }
      } finally {
        span.end();
      }
    });
  }
}
