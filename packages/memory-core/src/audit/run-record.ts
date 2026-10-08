import { z } from 'zod';
import { CASSETTE_FORMAT_VERSION, DecisionSchema, SEAMS } from '@repo/agent-cassette';

/**
 * The run record's vocabulary (P3-B, ADR 0007).
 *
 * A record holds what a production run received and every decision it made,
 * so that `audit:replay` can re-execute the run with nothing read from
 * anywhere else. The decisions are the cassette's — the same seam, the same
 * request builders and the same hash — plus one seam a cassette must never
 * hold: `memory.retrieve`. Evaluation replays the model axis and keeps memory
 * live (ADR 0005); an audit cannot re-query a store whose contents have moved
 * since, so the record keeps what retrieval returned.
 */
export const RECORD_SEAMS = [...SEAMS, 'memory.retrieve'] as const;

export type RecordSeam = (typeof RECORD_SEAMS)[number];

/** The seam a cassette does not have. */
export const RETRIEVAL_SEAM: RecordSeam = 'memory.retrieve';

/**
 * `DecisionSchema`, widened by one seam and by nothing else. A cassette parse
 * still rejects a retrieval; this accepts one.
 */
export const RunDecisionSchema = DecisionSchema.extend({ seam: z.enum(RECORD_SEAMS) });

export type RunDecision = z.infer<typeof RunDecisionSchema>;

/** Which compiled graph a record is of. Each has its own replay. */
export const RunGraphSchema = z.enum(['chat', 'prior-auth']);
export type RunGraph = z.infer<typeof RunGraphSchema>;

/** What served the model half, as it actually ran. */
export const RecordedModelAxisSchema = z.enum(['live', 'stub', 'replay']);
export type RecordedModelAxis = z.infer<typeof RecordedModelAxisSchema>;

/**
 * How a run ended. `partial` is a run whose graph finished but whose record has
 * a gap — an append that failed on the chat path — and is set by the caller,
 * not inferred here.
 */
export const RunOutcomeSchema = z.enum(['success', 'partial', 'error']);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** A full 40-character commit, lower-case hex. */
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'a 40-character hex commit sha');

/** What is known when a run starts. */
export const RunRecordOpenSchema = z.object({
  runId: z.string().uuid(),
  graph: RunGraphSchema,
  sessionId: z.string().uuid().nullable(),
  correlationId: z.string(),
  /** The body as received, before any parse. */
  request: z.unknown(),
  gitSha: GitShaSchema.nullable(),
  gitDirty: z.boolean().nullable(),
  chatModel: z.string().min(1),
  embeddingModel: z.string().min(1),
  embeddingDimensions: z.number().int().positive(),
  modelAxis: RecordedModelAxisSchema,
  /**
   * When the service received the request. Defaults to the database's clock;
   * the prior-authorization service passes the `receivedAt` its graph reads,
   * because that value is an input to the run.
   */
  startedAt: z.date().optional(),
});
export type RunRecordOpen = z.infer<typeof RunRecordOpenSchema>;

/** A record as stored. */
export const RunRecordSchema = RunRecordOpenSchema.extend({
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  outcome: RunOutcomeSchema.nullable(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** One decision row, in the order the decisions resolved. */
export const RunDecisionRowSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  formatVersion: z.number().int().positive(),
  decision: RunDecisionSchema,
});
export type RunDecisionRow = z.infer<typeof RunDecisionRowSchema>;

/** A record and its decisions, read back together. */
export interface StoredRun {
  readonly record: RunRecord;
  readonly decisions: readonly RunDecisionRow[];
}

/** The format every new decision row is written in. */
export const RUN_DECISION_FORMAT_VERSION = CASSETTE_FORMAT_VERSION;

/**
 * The run record's store.
 *
 * Written while the run executes: opened before the invoke, one row appended
 * per decision as it resolves rather than buffered, and closed in a `finally`
 * — because the run an auditor most wants is the one that crashed. Nothing
 * here updates or deletes a decision.
 */
export interface RunRecordRepository {
  /**
   * Opens a record, or finds the one already open under that `runId`.
   *
   * Idempotent: a second open of the same run changes nothing and reports how
   * many decisions the record already holds, so a resumed run continues the
   * ordinals rather than colliding with them. The first open's header wins.
   */
  open(record: RunRecordOpen): Promise<{ created: boolean; decisions: number }>;
  /** Appends one decision at the given ordinal. A taken ordinal throws. */
  append(runId: string, ordinal: number, decision: RunDecision): Promise<void>;
  /** Sets the outcome and the finish time. */
  close(runId: string, outcome: RunOutcome): Promise<void>;
  /** The record and its decisions in ordinal order, or `null` when there is none. */
  read(runId: string): Promise<StoredRun | null>;
}
