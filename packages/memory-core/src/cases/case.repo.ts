import { z } from 'zod';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTracer } from '@repo/telemetry';
import { AgentDispositionSchema, DeterminationRecordSchema } from '@repo/determination';
import { priorAuthCases } from './schema.js';

const tracer = getTracer('memory-core');

/**
 * The prior-authorization case layer (P3-E, ADR 0010): the queue, the clock
 * and the determination for every request `$submit` received. The agent's run
 * on a request finishes at `dispose`; everything after it is a row here.
 */

export const CaseStatusSchema = z.enum(['approved-automated', 'pended', 'decided']);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const CasePrioritySchema = z.enum(['expedited', 'standard']);

/**
 * A valid `Date`, from any realm. `z.date()` checks `instanceof Date`, which
 * fails for a `Date` made in another realm, as Jest's ESM VM context makes
 * every one the service spec creates; the tag check does not. The output is a
 * fresh `Date` in this realm.
 */
const InstantSchema = z
  .custom<Date>(
    (value) =>
      Object.prototype.toString.call(value) === '[object Date]' &&
      !Number.isNaN((value as Date).getTime()),
    { message: 'expected a valid Date' },
  )
  .transform((value) => new Date(value.getTime()));

/** A FHIR document as received or issued. The service parses it; this layer stores it. */
const DocumentSchema = z.record(z.unknown());

/**
 * What `$submit` writes, before it answers.
 *
 * `disposition` is P3-A's `AgentDisposition`, parsed on the way in and on the
 * way out: a row edited to hold a denial fails the read the way a forged
 * disposition fails `toClaimResponse`. The status has to agree with it, so a
 * referral cannot be enqueued as an approval or the reverse.
 */
/** A case id in the canonical lower-case form Postgres returns, so both stores sort it alike. */
const CaseIdSchema = z
  .string()
  .uuid()
  .refine((id) => id === id.toLowerCase(), { message: 'a case id is lower-case' });

export const NewCaseSchema = z
  .object({
    caseId: CaseIdSchema,
    status: z.enum(['approved-automated', 'pended']),
    priority: CasePrioritySchema,
    receivedAt: InstantSchema,
    decisionDueBy: InstantSchema,
    /** `system|value` of the patient's member identifier. */
    memberId: z.string().min(1),
    /** `system|value` of the insurer's identifier. */
    insurerId: z.string().min(1),
    /** `system|value` of the requesting provider's identifier. */
    providerId: z.string().min(1),
    hcpcs: z.string().min(1),
    request: DocumentSchema,
    disposition: AgentDispositionSchema,
    response: DocumentSchema,
    /** P3-C's `disposition.recommended` seq, when a ledger is configured. */
    recommendationSeq: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const expected =
      row.disposition.kind === 'automated-approval' ? 'approved-automated' : 'pended';
    if (row.status !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: `a ${row.disposition.kind} disposition is enqueued as ${expected}, not ${row.status}`,
      });
    }
    if (row.decisionDueBy.getTime() <= row.receivedAt.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionDueBy'],
        message: 'a decision is due after the request was received',
      });
    }
  });
export type NewCase = z.infer<typeof NewCaseSchema>;

/**
 * A clinician's decision on a pended case, already verified by the caller.
 * `determination` is parsed through P3-A's reader schema, which validates a
 * stored record without minting a branded denial.
 */
export const DecisionSchema = z
  .object({
    determination: DeterminationRecordSchema.refine(
      (determination) => determination.kind !== 'automated-approval',
      { message: 'a clinician decides a pended case; software approval is not a decision here' },
    ),
    reviewerId: z.string().min(1),
    reviewerKeyId: z.string().min(1),
    signature: z.string().min(1),
    decidedAt: InstantSchema,
    /** The response bundle now in force: what `$inquire` returns from here on. */
    response: DocumentSchema,
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export const CaseRowSchema = z
  .object({
    caseId: z.string().uuid(),
    status: CaseStatusSchema,
    priority: CasePrioritySchema,
    receivedAt: InstantSchema,
    decisionDueBy: InstantSchema,
    memberId: z.string(),
    insurerId: z.string(),
    providerId: z.string(),
    hcpcs: z.string(),
    request: DocumentSchema,
    disposition: AgentDispositionSchema,
    response: DocumentSchema,
    recommendationSeq: z.number().int().nullable(),
    determination: DeterminationRecordSchema.nullable(),
    reviewerId: z.string().nullable(),
    reviewerKeyId: z.string().nullable(),
    signature: z.string().nullable(),
    decidedAt: InstantSchema.nullable(),
    overdueFlaggedAt: InstantSchema.nullable(),
  })
  .strict();
export type CaseRow = z.infer<typeof CaseRowSchema>;

/** Query by example for `$inquire`. `hcpcs`, when given and non-empty, narrows to those codes. */
export const CaseExampleSchema = z
  .object({
    memberId: z.string().min(1),
    insurerId: z.string().min(1),
    providerId: z.string().min(1),
    hcpcs: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type CaseExample = z.infer<typeof CaseExampleSchema>;

/**
 * What `decide` did.
 *
 * - `decided`: the case was pended and now holds this decision.
 * - `unchanged`: the case was already decided with a byte-identical signature,
 *   so this is a retry, and the stored row is returned as it is.
 * - `conflict`: the case was decided otherwise, or was approved by automation.
 * - `not-found`: no case has that id.
 */
export type DecideResult =
  | { readonly outcome: 'decided' | 'unchanged' | 'conflict'; readonly row: CaseRow }
  | { readonly outcome: 'not-found' };

export interface DecideOptions {
  /**
   * Runs with the row locked, after the checks pass and before the update.
   * If it throws, nothing is written, the case stays pended, and the error
   * propagates. It is where P3-C's `determination.attested` append goes, so a
   * determination whose ledger entry failed is never stored or returned.
   */
  readonly beforeCommit?: (row: CaseRow) => Promise<void>;
}

/** One case `flagOverdue` flagged on this sweep. */
export interface OverdueCase {
  readonly caseId: string;
  readonly priority: 'expedited' | 'standard';
  readonly decisionDueBy: Date;
}

export interface CaseRepository {
  /** Inserts a case. A `caseId` that already exists throws. */
  enqueue(row: NewCase): Promise<void>;
  get(caseId: string): Promise<CaseRow | null>;
  /** Pended cases in clock order: deadline, then receipt, then case id. */
  queue(limit: number): Promise<CaseRow[]>;
  /** Every case for this member, insurer and provider, oldest receipt first. */
  match(example: CaseExample): Promise<CaseRow[]>;
  /** Decides a pended case at most once, under a lock. See `DecideResult`. */
  decide(caseId: string, decision: Decision, options?: DecideOptions): Promise<DecideResult>;
  /**
   * Sets `overdueFlaggedAt` on every pended case whose deadline is at or
   * before `now` and that has not been flagged, and returns those cases. A
   * case is flagged once; it stays pended.
   */
  flagOverdue(now: Date): Promise<OverdueCase[]>;
}

/** The row a decided case becomes. Shared by both implementations so they cannot drift. */
export function decidedRow(row: CaseRow, decision: Decision): CaseRow {
  return CaseRowSchema.parse({
    ...row,
    status: 'decided',
    determination: decision.determination,
    reviewerId: decision.reviewerId,
    reviewerKeyId: decision.reviewerKeyId,
    signature: decision.signature,
    decidedAt: decision.decidedAt,
    response: decision.response,
  });
}

/** Which `DecideResult` a decision on this row is, before anything is written. */
export function classifyDecision(
  row: CaseRow,
  decision: Decision,
): 'decide' | 'unchanged' | 'conflict' {
  if (row.status === 'pended') return 'decide';
  if (row.status === 'decided' && row.signature === decision.signature) return 'unchanged';
  return 'conflict';
}

type CaseRecord = typeof priorAuthCases.$inferSelect;

function toRow(record: CaseRecord): CaseRow {
  return CaseRowSchema.parse({
    ...record,
    recommendationSeq: record.recommendationSeq ?? null,
  });
}

/**
 * The case store on the configured memory axis.
 *
 * `decide` is one transaction: `SELECT … FOR UPDATE` the row, classify it,
 * run `beforeCommit`, update, commit. Two concurrent decisions on one case
 * serialize on the row lock, and the second finds it decided.
 */
export class DrizzleCaseRepository implements CaseRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async enqueue(row: NewCase): Promise<void> {
    const validated = NewCaseSchema.parse(row);
    return span('memory.cases.enqueue', async () => {
      await this.db.insert(priorAuthCases).values({
        ...validated,
        determination: null,
        reviewerId: null,
        reviewerKeyId: null,
        signature: null,
        decidedAt: null,
        overdueFlaggedAt: null,
      });
    });
  }

  async get(caseId: string): Promise<CaseRow | null> {
    return span('memory.cases.get', async () => {
      if (!z.string().uuid().safeParse(caseId).success) return null;
      const [record] = await this.db
        .select()
        .from(priorAuthCases)
        .where(eq(priorAuthCases.caseId, caseId))
        .limit(1);
      return record === undefined ? null : toRow(record);
    });
  }

  async queue(limit: number): Promise<CaseRow[]> {
    return span('memory.cases.queue', async () => {
      const records = await this.db
        .select()
        .from(priorAuthCases)
        .where(eq(priorAuthCases.status, 'pended'))
        .orderBy(
          asc(priorAuthCases.decisionDueBy),
          asc(priorAuthCases.receivedAt),
          asc(priorAuthCases.caseId),
        )
        .limit(limit);
      return records.map(toRow);
    });
  }

  async match(example: CaseExample): Promise<CaseRow[]> {
    const validated = CaseExampleSchema.parse(example);
    return span('memory.cases.match', async () => {
      const records = await this.db
        .select()
        .from(priorAuthCases)
        .where(
          and(
            eq(priorAuthCases.memberId, validated.memberId),
            eq(priorAuthCases.insurerId, validated.insurerId),
            eq(priorAuthCases.providerId, validated.providerId),
            validated.hcpcs === undefined || validated.hcpcs.length === 0
              ? undefined
              : inArray(priorAuthCases.hcpcs, validated.hcpcs),
          ),
        )
        .orderBy(asc(priorAuthCases.receivedAt), asc(priorAuthCases.caseId));
      return records.map(toRow);
    });
  }

  async decide(
    caseId: string,
    decision: Decision,
    options: DecideOptions = {},
  ): Promise<DecideResult> {
    const validated = DecisionSchema.parse(decision);
    return span('memory.cases.decide', async () => {
      if (!z.string().uuid().safeParse(caseId).success) return { outcome: 'not-found' };
      return this.db.transaction(async (tx): Promise<DecideResult> => {
        const [record] = await tx
          .select()
          .from(priorAuthCases)
          .where(eq(priorAuthCases.caseId, caseId))
          .for('update');
        if (record === undefined) return { outcome: 'not-found' };

        const row = toRow(record);
        const kind = classifyDecision(row, validated);
        if (kind !== 'decide') return { outcome: kind, row };

        await options.beforeCommit?.(row);
        const next = decidedRow(row, validated);
        await tx
          .update(priorAuthCases)
          .set({
            status: 'decided',
            determination: next.determination,
            reviewerId: next.reviewerId,
            reviewerKeyId: next.reviewerKeyId,
            signature: next.signature,
            decidedAt: next.decidedAt,
            response: next.response,
          })
          .where(and(eq(priorAuthCases.caseId, caseId), eq(priorAuthCases.status, 'pended')));
        return { outcome: 'decided', row: next };
      });
    });
  }

  async flagOverdue(now: Date): Promise<OverdueCase[]> {
    return span('memory.cases.flag_overdue', async () => {
      const flagged = await this.db
        .update(priorAuthCases)
        .set({ overdueFlaggedAt: now })
        .where(
          and(
            eq(priorAuthCases.status, 'pended'),
            lte(priorAuthCases.decisionDueBy, now),
            isNull(priorAuthCases.overdueFlaggedAt),
          ),
        )
        .returning({
          caseId: priorAuthCases.caseId,
          priority: priorAuthCases.priority,
          decisionDueBy: priorAuthCases.decisionDueBy,
        });
      return flagged
        .map((row) => ({
          caseId: row.caseId,
          priority: CasePrioritySchema.parse(row.priority),
          decisionDueBy: row.decisionDueBy,
        }))
        .sort(
          (a, b) =>
            a.decisionDueBy.getTime() - b.decisionDueBy.getTime() ||
            (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0),
        );
    });
  }
}

function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (active) => {
    try {
      return await fn();
    } finally {
      active.end();
    }
  });
}
