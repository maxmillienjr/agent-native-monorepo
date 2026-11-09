import { z } from 'zod';
import type pg from 'pg';
import { getTracer } from '@repo/telemetry';

const tracer = getTracer('memory-core');

export const RunInspectionInputSchema = z.object({
  /** `reflect` writes `run_id` on episodes and `episodeId` on facts. */
  runId: z.string().uuid(),
});
export type RunInspectionInput = z.input<typeof RunInspectionInputSchema>;

export interface RunInspection {
  readonly runId: string;
  readonly episodeRowsForRun: number;
  readonly factRowsForRun: number;
}

/**
 * Reads back what one run persisted.
 *
 * It exists because the evaluation harness has to answer "did `reflect`
 * actually write the episode, upsert the fact" and there was nothing to ask.
 * `EpisodicRepository.findBySession` was the closest thing, and a session is
 * not a run.
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

export class PgMemoryInspector implements MemoryInspector {
  constructor(private readonly pool: pg.Pool) {}

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

        const inspection: RunInspection = {
          runId: validated.runId,
          episodeRowsForRun: Number(episodes.rows[0]?.n ?? 0),
          factRowsForRun: Number(facts.rows[0]?.n ?? 0),
        };

        span.setAttribute('episodeRowsForRun', inspection.episodeRowsForRun);
        span.setAttribute('factRowsForRun', inspection.factRowsForRun);
        return inspection;
      } finally {
        span.end();
      }
    });
  }
}
