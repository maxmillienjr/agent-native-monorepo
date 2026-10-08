import { z } from 'zod';
import type pg from 'pg';
import { getTracer } from '@repo/telemetry';
import {
  RUN_DECISION_FORMAT_VERSION,
  RunDecisionRowSchema,
  RunDecisionSchema,
  RunOutcomeSchema,
  RunRecordOpenSchema,
  RunRecordSchema,
  type RunDecision,
  type RunOutcome,
  type RunRecordOpen,
  type RunRecordRepository,
  type StoredRun,
} from './run-record.js';

const tracer = getTracer('memory-core');

const RunIdSchema = z.string().uuid();

/** A `run_records` row as `pg` returns it. Parsed, not cast: this is a database boundary. */
const RecordRowSchema = z.object({
  run_id: z.string(),
  graph: z.string(),
  session_id: z.string().nullable(),
  correlation_id: z.string(),
  request: z.unknown(),
  git_sha: z.string().nullable(),
  git_dirty: z.boolean().nullable(),
  chat_model: z.string(),
  embedding_model: z.string(),
  embedding_dimensions: z.number(),
  model_axis: z.string(),
  started_at: z.date(),
  finished_at: z.date().nullable(),
  outcome: z.string().nullable(),
});

const DecisionRowSchema = z.object({
  ordinal: z.number(),
  format_version: z.number(),
  decision: z.unknown(),
});

/**
 * The run record in Postgres, beside the checkpoints, written by the
 * service's own role.
 *
 * It lives in `memory-core` for the reason P3-C gives for the ledger not
 * living here: the database role. These tables are written with the role that
 * writes `episodes` and the checkpoints, under the same migrator, so they
 * belong to the package that owns that role's writes (`.agents/reviewer.md`
 * rule 4). It is not a memory tier — nothing in a graph's dependencies can
 * read it.
 *
 * Every value is parsed on the way in and on the way out, including each
 * decision through `RunDecisionSchema`: a row edited to hold something that is
 * not a decision fails the read rather than reaching a replay.
 */
export class PgRunRecordRepository implements RunRecordRepository {
  constructor(private readonly pool: pg.Pool) {}

  async open(input: RunRecordOpen): Promise<{ created: boolean; decisions: number }> {
    const record = RunRecordOpenSchema.parse(input);

    return this.span('memory.run_record.open', record.runId, async () => {
      const inserted = await this.pool.query(
        `INSERT INTO run_records (
           run_id, graph, session_id, correlation_id, request, git_sha, git_dirty,
           chat_model, embedding_model, embedding_dimensions, model_axis, started_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, now()))
         ON CONFLICT (run_id) DO NOTHING`,
        [
          record.runId,
          record.graph,
          record.sessionId,
          record.correlationId,
          // `pg` would send an array as a Postgres array literal; JSON text is
          // what a jsonb parameter has to be.
          JSON.stringify(record.request ?? null),
          record.gitSha,
          record.gitDirty,
          record.chatModel,
          record.embeddingModel,
          record.embeddingDimensions,
          record.modelAxis,
          record.startedAt ?? null,
        ],
      );

      const counted = await this.pool.query<{ decisions: number }>(
        'SELECT count(*)::int AS decisions FROM run_decisions WHERE run_id = $1',
        [record.runId],
      );

      return {
        created: inserted.rowCount === 1,
        decisions: z.number().int().parse(counted.rows[0]?.decisions),
      };
    });
  }

  async append(runId: string, ordinal: number, decision: RunDecision): Promise<void> {
    const id = RunIdSchema.parse(runId);
    const position = z.number().int().nonnegative().parse(ordinal);
    const validated = RunDecisionSchema.parse(decision);

    await this.span('memory.run_record.append', id, async () => {
      // A bare INSERT, on purpose: an ordinal that is already taken means two
      // writers think they own the run, and that must be loud.
      await this.pool.query(
        `INSERT INTO run_decisions (run_id, ordinal, format_version, decision)
         VALUES ($1, $2, $3, $4)`,
        [id, position, RUN_DECISION_FORMAT_VERSION, JSON.stringify(validated)],
      );
    });
  }

  async close(runId: string, outcome: RunOutcome): Promise<void> {
    const id = RunIdSchema.parse(runId);
    const ended = RunOutcomeSchema.parse(outcome);

    await this.span('memory.run_record.close', id, async () => {
      const updated = await this.pool.query(
        'UPDATE run_records SET finished_at = now(), outcome = $2 WHERE run_id = $1',
        [id, ended],
      );
      if (updated.rowCount !== 1) {
        throw new Error(`run record ${id} cannot be closed: it was never opened`);
      }
    });
  }

  async read(runId: string): Promise<StoredRun | null> {
    const id = RunIdSchema.parse(runId);

    const records = await this.pool.query('SELECT * FROM run_records WHERE run_id = $1', [id]);
    const raw = records.rows[0] as unknown;
    if (raw === undefined) return null;
    const row = RecordRowSchema.parse(raw);

    const decisions = await this.pool.query(
      `SELECT ordinal, format_version, decision FROM run_decisions
       WHERE run_id = $1 ORDER BY ordinal`,
      [id],
    );

    return {
      record: RunRecordSchema.parse({
        runId: row.run_id,
        graph: row.graph,
        sessionId: row.session_id,
        correlationId: row.correlation_id,
        request: row.request,
        gitSha: row.git_sha,
        gitDirty: row.git_dirty,
        chatModel: row.chat_model,
        embeddingModel: row.embedding_model,
        embeddingDimensions: row.embedding_dimensions,
        modelAxis: row.model_axis,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        outcome: row.outcome,
      }),
      decisions: decisions.rows.map((raw: unknown) => {
        const decision = DecisionRowSchema.parse(raw);
        return RunDecisionRowSchema.parse({
          ordinal: decision.ordinal,
          formatVersion: decision.format_version,
          decision: decision.decision,
        });
      }),
    };
  }

  /**
   * One span per write, carrying the run id and nothing else: a decision's
   * request and response are content, and content never goes on a span.
   */
  private span<T>(name: string, runId: string, work: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttribute('run_id', runId);
        return await work();
      } finally {
        span.end();
      }
    });
  }
}
