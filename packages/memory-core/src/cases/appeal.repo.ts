import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq, lte, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { canonicalJson } from '@repo/agent-cassette';
import {
  AdverseDeterminationRecordSchema,
  ClinicianAttestationSchema,
  ReconsiderationRecordSchema,
  type Reconsideration,
} from '@repo/determination';
import { getTracer } from '@repo/telemetry';
import {
  CaseIdSchema,
  CasePrioritySchema,
  DocumentSchema,
  InstantSchema,
  toRow as toCaseRow,
  type CaseRow,
  type CaseStatus,
} from './case.repo.js';
import { priorAuthAppeals, priorAuthCases } from './schema.js';

const tracer = getTracer('memory-core');

/**
 * Requests for reconsideration of an adverse determination (P3-F): 42 CFR
 * Part 422, Subpart M, standard and expedited reconsiderations of pre-service
 * requests for an item or service, and nothing else.
 *
 * An appeal is `filed`, then one of three terminal states: `reversed`, with
 * the case's response in force replaced by an approval; `forwarded` to the
 * independent entity, because a physician affirmed the denial or because the
 * deadline passed; or `dismissed`. There is no `affirmed` state, because
 * § 422.590(a)(2) and (e)(5) make the forward the consequence of the
 * affirmation, and nothing should hold one without the other.
 */

export const AppealStatusSchema = z.enum(['filed', 'reversed', 'forwarded', 'dismissed']);
export type AppealStatus = z.infer<typeof AppealStatusSchema>;

export const ForwardReasonSchema = z.enum(['affirmed', 'deadline-lapsed']);
export type ForwardReason = z.infer<typeof ForwardReasonSchema>;

/**
 * The reasons § 422.582(f) lists for a dismissal that the data can carry. An
 * `untimely` dismissal is for a request filed after the window without good
 * cause, so the route refuses it on a timely appeal.
 */
export const DismissalReasonSchema = z.enum([
  'not-a-proper-party',
  'invalid-request',
  'untimely',
  'withdrawn',
]);
export type DismissalReason = z.infer<typeof DismissalReasonSchema>;

/**
 * Who filed, how, and what they asserted. The roles are § 422.578's: a party
 * (the enrollee or their representative) or a physician treating the
 * enrollee, who for a standard pre-service reconsideration acts "upon
 * providing notice to the enrollee". Nothing verifies that a physician treats
 * the enrollee or that a representative was appointed; the row records what
 * was asserted.
 */
export const FilerSchema = z
  .object({
    role: z.enum(['enrollee', 'representative', 'physician']),
    /** Synthetic in every fixture. */
    name: z.string().trim().min(1),
    identifier: z
      .object({ system: z.string().min(1), value: z.string().min(1) })
      .strict()
      .optional(),
    /** § 422.584(c)(1): an oral request is documented in writing; this row is that record. */
    channel: z.enum(['written', 'oral']),
    expedite: z.object({ requested: z.boolean(), physicianSupport: z.boolean() }).strict(),
    enrolleeNotified: z.literal(true).optional(),
    /** § 422.582(b)(1)'s "evidence to the contrary": a receipt later than the presumed one. */
    noticeReceivedAt: z
      .union([z.string().date(), z.string().datetime({ offset: true })])
      .optional(),
  })
  .strict()
  .superRefine((filer, ctx) => {
    if (
      filer.role === 'physician' &&
      !filer.expedite.requested &&
      filer.enrolleeNotified !== true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['enrolleeNotified'],
        message:
          'a treating physician files a standard reconsideration upon providing notice to the ' +
          'enrollee (42 CFR § 422.578), so enrolleeNotified must be true',
      });
    }
  });
export type Filer = z.infer<typeof FilerSchema>;

/** The filer's statement and evidence (§ 422.586), stored as received. */
export const AppealRequestSchema = z
  .object({
    statement: z.string().trim().min(1),
    evidence: z
      .object({ resourceType: z.literal('Bundle') })
      .passthrough()
      .optional(),
  })
  .strict();

/** A signed dismissal. The attestation names who dismissed, as a reconsideration's does. */
export const DismissalSchema = z
  .object({
    reason: DismissalReasonSchema,
    explanation: z.string().trim().min(1),
    attestation: ClinicianAttestationSchema,
  })
  .strict();
export type Dismissal = z.infer<typeof DismissalSchema>;

/** Who signed an action on an appeal, with which key, and when it was recorded. Verified by the caller. */
export const SignedActionSchema = z
  .object({
    reviewerId: z.string().min(1),
    reviewerKeyId: z.string().min(1),
    signature: z.string().min(1),
    decidedAt: InstantSchema,
  })
  .strict();
export type SignedAction = z.infer<typeof SignedActionSchema>;

/**
 * What filing writes. The deadlines are computed by the caller from
 * `@repo/prior-auth`'s appeal clock; this layer checks that they agree with
 * each other and with the filing, and takes the initial reviewer from the case
 * itself, so a caller cannot name the wrong one.
 */
export const NewAppealSchema = z
  .object({
    appealId: CaseIdSchema,
    caseId: CaseIdSchema,
    priority: CasePrioritySchema,
    filer: FilerSchema,
    receivedAt: InstantSchema,
    filingDeadline: InstantSchema,
    timely: z.boolean(),
    reconsiderationDueBy: InstantSchema,
    // Checked against AppealRequestSchema but stored as given, so key order survives.
    request: DocumentSchema.refine((value) => AppealRequestSchema.safeParse(value).success, {
      message: 'an appeal request is a non-blank statement and, optionally, an evidence Bundle',
    }),
  })
  .strict()
  .superRefine((row, ctx) => {
    const expected = row.filer.expedite.requested ? 'expedited' : 'standard';
    if (row.priority !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['priority'],
        message: `a request that ${row.filer.expedite.requested ? 'asks' : 'does not ask'} to be expedited is ${expected}`,
      });
    }
    if (row.reconsiderationDueBy.getTime() <= row.receivedAt.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reconsiderationDueBy'],
        message: 'a reconsideration is due after the request was received',
      });
    }
    if (row.timely !== row.receivedAt.getTime() <= row.filingDeadline.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timely'],
        message: 'timely is whether the request was received by the filing deadline',
      });
    }
  });
export type NewAppeal = z.infer<typeof NewAppealSchema>;

export const AppealRowSchema = z
  .object({
    appealId: z.string().uuid(),
    caseId: z.string().uuid(),
    initialReviewerId: z.string().min(1),
    status: AppealStatusSchema,
    priority: CasePrioritySchema,
    filer: FilerSchema,
    receivedAt: InstantSchema,
    filingDeadline: InstantSchema,
    timely: z.boolean(),
    reconsiderationDueBy: InstantSchema,
    request: DocumentSchema,
    /** Parsed through P3-A's reader schema, which refuses a record whose two reviewers are one. */
    reconsideration: ReconsiderationRecordSchema.nullable(),
    reviewerId: z.string().nullable(),
    reviewerKeyId: z.string().nullable(),
    signature: z.string().nullable(),
    decidedAt: InstantSchema.nullable(),
    dismissalReason: DismissalReasonSchema.nullable(),
    dismissal: DismissalSchema.nullable(),
    forwardReason: ForwardReasonSchema.nullable(),
    forwardedAt: InstantSchema.nullable(),
    caseFileDigest: z.string().nullable(),
  })
  .strict()
  .refine((row) => row.reviewerId !== row.initialReviewerId, {
    message: 'an appeal is acted on by someone not involved in the determination',
    path: ['reviewerId'],
  });
export type AppealRow = z.infer<typeof AppealRowSchema>;

/**
 * What `file` did.
 *
 * - `filed`: the appeal is recorded.
 * - `already-open`: the case has an appeal that is not dismissed, returned.
 * - `not-appealable`: the case is not decided with an adverse determination.
 *   An automated approval, a clinician approval and a pended case have
 *   nothing a reconsideration can reverse. A pended case past its deadline is
 *   appealable in law (§ 422.568(f)), and is out of scope here.
 * - `not-found`: no case has that id.
 */
export type FileResult =
  | { readonly outcome: 'filed' | 'already-open'; readonly row: AppealRow }
  | {
      readonly outcome: 'not-appealable';
      readonly caseStatus: CaseStatus;
      readonly determination: string | null;
    }
  | { readonly outcome: 'not-found' };

/**
 * What `reconsider` or `dismiss` did.
 *
 * - `recorded`: the appeal was filed and now holds this action.
 * - `unchanged`: it already holds an action with a byte-identical signature,
 *   so this is a retry, and the stored rows are returned as they are.
 * - `conflict`: it was reversed, forwarded or dismissed otherwise.
 * - `lapsed`: it was filed and past its deadline, so this call forwarded it
 *   as deemed affirmed (§ 422.590(d), (g)) and recorded nothing else.
 * - `not-found`: no appeal has that id.
 *
 * `caseRow` is the case as it stands after the call: for a reversal, with the
 * approval as its response in force.
 */
export type ActionResult =
  | {
      readonly outcome: 'recorded' | 'unchanged' | 'conflict' | 'lapsed';
      readonly row: AppealRow;
      readonly caseRow: CaseRow;
    }
  | { readonly outcome: 'not-found' };

export interface ActionOptions {
  /**
   * Runs with both rows locked, with the appeal row about to be written, and
   * before it is: the action's, or a lapse forward's when the action found
   * the appeal past its deadline. If it throws, nothing is written, the appeal
   * stays filed, and the error propagates. It is where P3-C's ledger append
   * goes, and it is given the row so the append can carry what the row will
   * hold, a forward's case-file digest included.
   */
  readonly beforeCommit?: (next: AppealRow, caseRow: CaseRow) => Promise<void>;
}

export interface ReconsiderOptions extends ActionOptions {
  /** The response a reversal puts in force on the case. Required for a reversal, refused for an affirmation. */
  readonly response?: Record<string, unknown>;
}

export interface FileOptions {
  /**
   * Runs once the appeal is inserted and before the transaction commits. If
   * it throws, the insert is rolled back and the error propagates.
   */
  readonly beforeCommit?: (filed: AppealRow, caseRow: CaseRow) => Promise<void>;
}

/** One appeal `forwardLapsed` forwarded on this sweep. */
export interface ForwardedAppeal {
  readonly appealId: string;
  readonly caseId: string;
  readonly priority: 'expedited' | 'standard';
  readonly reconsiderationDueBy: Date;
  readonly forwardedAt: Date;
  readonly caseFileDigest: string;
}

export interface AppealRepository {
  /** Files an appeal on a case decided with an adverse determination. See `FileResult`. */
  file(row: NewAppeal, options?: FileOptions): Promise<FileResult>;
  get(appealId: string): Promise<AppealRow | null>;
  /** Filed appeals in clock order: reconsideration deadline, then receipt, then appeal id. */
  queue(limit: number): Promise<AppealRow[]>;
  /**
   * Records a reconsideration, once, under a lock on the appeal and its case.
   * A reversal replaces the case's response; an affirmation forwards the
   * appeal in the same transaction. The case's determination, reviewer and
   * signature are never touched. Takes the branded `Reconsideration`, so only
   * `attestReconsideration` can produce what it accepts.
   */
  reconsider(
    appealId: string,
    reconsideration: Reconsideration,
    signed: SignedAction,
    options?: ReconsiderOptions,
  ): Promise<ActionResult>;
  /** Records a dismissal, once, under the same lock. */
  dismiss(
    appealId: string,
    dismissal: Dismissal,
    signed: SignedAction,
    options?: ActionOptions,
  ): Promise<ActionResult>;
  /**
   * Forwards every filed appeal at or past its deadline as `deadline-lapsed`
   * (§ 422.590(d), (g)), each under its own lock and in one conditional
   * update, and returns those it forwarded. An appeal is forwarded once.
   *
   * A forward whose `beforeCommit` throws is rolled back, and the appeal stays
   * filed for the next sweep. Without `onError` the error propagates and the
   * sweep stops there; with it, the error is reported and the sweep goes on,
   * so one appeal the ledger refuses does not hold back every later one.
   */
  forwardLapsed(now: Date, options?: ForwardOptions): Promise<ForwardedAppeal[]>;
}

export interface ForwardOptions extends ActionOptions {
  /** Called for each forward that failed and was rolled back; the sweep continues. */
  readonly onError?: (appealId: string, error: unknown) => void;
}

// --- Shared by both stores, so they cannot drift -----------------------------

/** Whether a case can be appealed here: decided, with an adverse determination. */
export function appealableReviewer(caseRow: CaseRow): string | null {
  if (caseRow.status !== 'decided' || caseRow.reviewerId === null) return null;
  return AdverseDeterminationRecordSchema.safeParse(caseRow.determination).success
    ? caseRow.reviewerId
    : null;
}

export function notAppealable(caseRow: CaseRow): FileResult {
  return {
    outcome: 'not-appealable',
    caseStatus: caseRow.status,
    determination: caseRow.determination?.kind ?? null,
  };
}

/** The row a filing becomes. */
export function filedRow(row: NewAppeal, initialReviewerId: string): AppealRow {
  return AppealRowSchema.parse({
    ...row,
    initialReviewerId,
    status: 'filed',
    reconsideration: null,
    reviewerId: null,
    reviewerKeyId: null,
    signature: null,
    decidedAt: null,
    dismissalReason: null,
    dismissal: null,
    forwardReason: null,
    forwardedAt: null,
    caseFileDigest: null,
  });
}

/** Which `ActionResult` an action on this appeal is, before anything is written. */
export function classifyAction(
  appeal: AppealRow,
  signature: string,
  now: Date,
): 'apply' | 'lapse' | 'unchanged' | 'conflict' {
  if (appeal.status === 'filed') {
    return now.getTime() >= appeal.reconsiderationDueBy.getTime() ? 'lapse' : 'apply';
  }
  return appeal.signature === signature ? 'unchanged' : 'conflict';
}

/**
 * The explanation a lapse forward carries, in place of a physician's: the
 * failure is the affirmation, and the rule says so.
 */
export const LAPSE_EXPLANATION = {
  standard:
    'No reconsidered determination was made within 30 calendar days of receipt of the request. ' +
    'Under 42 CFR § 422.590(d) that failure is an affirmation of the adverse organization ' +
    'determination, and the case file is forwarded to the independent entity.',
  expedited:
    'No reconsidered determination was made within 72 hours of receipt of the request. ' +
    'Under 42 CFR § 422.590(d) that failure is an affirmation of the adverse organization ' +
    'determination, and under § 422.590(g) the case file is forwarded to the independent ' +
    'entity within 24 hours of the deadline.',
} as const;

/**
 * The case file the plan forwards to the independent entity (§ 422.590(a)(2),
 * § 422.592(a)): the request, the agent's findings, the initial denial, the
 * filing and its evidence, the reconsideration if there was one, and the
 * written explanation. It is a function of the two rows alone, so
 * `GET …/case-file` rebuilds exactly what was digested at the forward.
 *
 * The findings are in it because a reconsideration reviews "the evidence and
 * findings upon which it was based" (§ 422.580). That makes it the second
 * place the model's rationale is served, after the case view.
 */
export function caseFileOf(appeal: AppealRow, caseRow: CaseRow): Record<string, unknown> {
  if (appeal.caseId !== caseRow.caseId) {
    throw new Error(`appeal ${appeal.appealId} is not on case ${caseRow.caseId}`);
  }
  const explanation =
    appeal.forwardReason === 'affirmed'
      ? (appeal.reconsideration?.explanation ?? null)
      : appeal.forwardReason === 'deadline-lapsed'
        ? LAPSE_EXPLANATION[appeal.priority]
        : null;
  return {
    caseId: caseRow.caseId,
    appealId: appeal.appealId,
    request: caseRow.request,
    findings: caseRow.disposition.kind === 'refer-to-clinician' ? caseRow.disposition.findings : [],
    initialDetermination: {
      determination: caseRow.determination,
      reviewerId: caseRow.reviewerId,
      reviewerKeyId: caseRow.reviewerKeyId,
      signature: caseRow.signature,
      decidedAt: caseRow.decidedAt?.toISOString() ?? null,
    },
    appeal: {
      priority: appeal.priority,
      filer: appeal.filer,
      receivedAt: appeal.receivedAt.toISOString(),
      filingDeadline: appeal.filingDeadline.toISOString(),
      timely: appeal.timely,
      reconsiderationDueBy: appeal.reconsiderationDueBy.toISOString(),
      request: appeal.request,
    },
    reconsideration:
      appeal.reconsideration === null
        ? null
        : {
            record: appeal.reconsideration,
            reviewerKeyId: appeal.reviewerKeyId,
            signature: appeal.signature,
            decidedAt: appeal.decidedAt?.toISOString() ?? null,
          },
    forward:
      appeal.forwardReason === null
        ? null
        : {
            reason: appeal.forwardReason,
            forwardedAt: appeal.forwardedAt?.toISOString() ?? null,
            explanation,
          },
  };
}

/** The SHA-256 of a case file's canonical JSON, hex. */
export function caseFileDigest(caseFile: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(caseFile), 'utf8').digest('hex');
}

/** The row a filed appeal becomes when it is forwarded, with its case file digested. */
function forwardedRow(
  appeal: AppealRow,
  caseRow: CaseRow,
  forward: { reason: ForwardReason; at: Date },
  signedPart: Partial<AppealRow>,
): AppealRow {
  const next: AppealRow = {
    ...appeal,
    ...signedPart,
    status: 'forwarded',
    forwardReason: forward.reason,
    forwardedAt: forward.at,
    caseFileDigest: null,
  };
  return AppealRowSchema.parse({
    ...next,
    caseFileDigest: caseFileDigest(caseFileOf(next, caseRow)),
  });
}

/** A filed appeal past its deadline, forwarded as deemed affirmed at `now`. */
export function lapsedRow(appeal: AppealRow, caseRow: CaseRow, now: Date): AppealRow {
  return forwardedRow(appeal, caseRow, { reason: 'deadline-lapsed', at: now }, {});
}

/** The row a reconsideration makes of a filed appeal: reversed, or forwarded as affirmed. */
export function reconsideredRow(
  appeal: AppealRow,
  caseRow: CaseRow,
  reconsideration: z.infer<typeof ReconsiderationRecordSchema>,
  signed: SignedAction,
): AppealRow {
  const signedPart = {
    reconsideration,
    reviewerId: signed.reviewerId,
    reviewerKeyId: signed.reviewerKeyId,
    signature: signed.signature,
    decidedAt: signed.decidedAt,
  };
  if (reconsideration.kind === 'affirmation') {
    // § 422.590(e)(5) allows 24 hours after an expedited affirmation and
    // (a)(2) the 30-day deadline for a standard one; zero satisfies both.
    return forwardedRow(appeal, caseRow, { reason: 'affirmed', at: signed.decidedAt }, signedPart);
  }
  return AppealRowSchema.parse({ ...appeal, ...signedPart, status: 'reversed' });
}

/** The row a dismissal makes of a filed appeal. */
export function dismissedRow(
  appeal: AppealRow,
  dismissal: Dismissal,
  signed: SignedAction,
): AppealRow {
  return AppealRowSchema.parse({
    ...appeal,
    status: 'dismissed',
    reviewerId: signed.reviewerId,
    reviewerKeyId: signed.reviewerKeyId,
    signature: signed.signature,
    decidedAt: signed.decidedAt,
    dismissalReason: dismissal.reason,
    dismissal,
  });
}

/**
 * The checks every store makes on a reconsideration before taking a lock.
 * They are the caller's to have made already; failing one is a defect in the
 * caller, so they throw rather than answer.
 */
export function checkReconsideration(
  reconsideration: Reconsideration,
  signed: SignedAction,
  options: ReconsiderOptions,
): { record: z.infer<typeof ReconsiderationRecordSchema>; signed: SignedAction } {
  const record = ReconsiderationRecordSchema.parse(reconsideration);
  const validated = SignedActionSchema.parse(signed);
  if (record.attestation.reviewerId !== validated.reviewerId) {
    throw new Error('the reconsideration and its signature name different reviewers');
  }
  if (record.kind === 'reversal' && options.response === undefined) {
    throw new Error('a reversal puts a response in force, and none was given');
  }
  if (record.kind === 'affirmation' && options.response !== undefined) {
    throw new Error('an affirmation leaves the denial in force, so it takes no response');
  }
  return { record, signed: validated };
}

/** As `checkReconsideration`, for a dismissal, with the non-involvement rule applied here. */
export function checkDismissal(
  dismissal: Dismissal,
  signed: SignedAction,
): { dismissal: Dismissal; signed: SignedAction } {
  const validated = DismissalSchema.parse(dismissal);
  const validatedSigned = SignedActionSchema.parse(signed);
  if (validated.attestation.reviewerId !== validatedSigned.reviewerId) {
    throw new Error('the dismissal and its signature name different reviewers');
  }
  return { dismissal: validated, signed: validatedSigned };
}

/** The reconsideration names the initial reviewer this appeal names, and is signed by another. */
export function checkInvolvement(
  appeal: AppealRow,
  reviewerId: string,
  initialReviewerId?: string,
): void {
  if (initialReviewerId !== undefined && initialReviewerId !== appeal.initialReviewerId) {
    throw new Error(
      `the reconsideration names a determination appeal ${appeal.appealId} is not about`,
    );
  }
  if (reviewerId === appeal.initialReviewerId) {
    throw new Error(
      `${reviewerId} made the determination under appeal ${appeal.appealId}, and may not act on it`,
    );
  }
}

// --- Postgres ------------------------------------------------------------------

type AppealRecord = typeof priorAuthAppeals.$inferSelect;

function toAppealRow(record: AppealRecord): AppealRow {
  return AppealRowSchema.parse(record);
}

/** The columns an action sets, from the row it computed. */
function actionColumns(next: AppealRow) {
  return {
    status: next.status,
    reconsideration: next.reconsideration,
    reviewerId: next.reviewerId,
    reviewerKeyId: next.reviewerKeyId,
    signature: next.signature,
    decidedAt: next.decidedAt,
    dismissalReason: next.dismissalReason,
    dismissal: next.dismissal,
    forwardReason: next.forwardReason,
    forwardedAt: next.forwardedAt,
    caseFileDigest: next.caseFileDigest,
  };
}

/**
 * The appeal store on the configured memory axis.
 *
 * `reconsider` and `dismiss` are one transaction each: lock the appeal row,
 * then the case row, classify, run `beforeCommit`, update, commit. The case
 * is locked `FOR NO KEY UPDATE`, because a reversal changes its response and
 * no key, and filing a second appeal on the same case takes the foreign key's
 * `KEY SHARE` lock on it, which that mode does not block.
 */
export class DrizzleAppealRepository implements AppealRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async file(row: NewAppeal, options: FileOptions = {}): Promise<FileResult> {
    const validated = NewAppealSchema.parse(row);
    return span('memory.appeals.file', () =>
      this.db.transaction(async (tx): Promise<FileResult> => {
        const [record] = await tx
          .select()
          .from(priorAuthCases)
          .where(eq(priorAuthCases.caseId, validated.caseId))
          .limit(1);
        if (record === undefined) return { outcome: 'not-found' };
        const caseRow = toCaseRow(record);
        const initialReviewerId = appealableReviewer(caseRow);
        if (initialReviewerId === null) return notAppealable(caseRow);

        const filed = filedRow(validated, initialReviewerId);
        // The partial unique index is the one-open rule; a concurrent filing
        // on the same case waits on it and then does nothing.
        const inserted = await tx
          .insert(priorAuthAppeals)
          .values({ ...filed, request: validated.request })
          .onConflictDoNothing({
            target: priorAuthAppeals.caseId,
            where: sql`${priorAuthAppeals.status} <> 'dismissed'`,
          })
          .returning({ appealId: priorAuthAppeals.appealId });
        if (inserted.length === 1) {
          // A throw here rolls the insert back: an appeal whose ledger entry
          // failed is never recorded.
          await options.beforeCommit?.(filed, caseRow);
          return { outcome: 'filed', row: filed };
        }

        const [open] = await tx
          .select()
          .from(priorAuthAppeals)
          .where(
            and(
              eq(priorAuthAppeals.caseId, validated.caseId),
              ne(priorAuthAppeals.status, 'dismissed'),
            ),
          )
          .limit(1);
        if (open === undefined) throw new Error(`case ${validated.caseId} lost its open appeal`);
        return { outcome: 'already-open', row: toAppealRow(open) };
      }),
    );
  }

  async get(appealId: string): Promise<AppealRow | null> {
    return span('memory.appeals.get', async () => {
      if (!z.string().uuid().safeParse(appealId).success) return null;
      const [record] = await this.db
        .select()
        .from(priorAuthAppeals)
        .where(eq(priorAuthAppeals.appealId, appealId))
        .limit(1);
      return record === undefined ? null : toAppealRow(record);
    });
  }

  async queue(limit: number): Promise<AppealRow[]> {
    return span('memory.appeals.queue', async () => {
      const records = await this.db
        .select()
        .from(priorAuthAppeals)
        .where(eq(priorAuthAppeals.status, 'filed'))
        .orderBy(
          asc(priorAuthAppeals.reconsiderationDueBy),
          asc(priorAuthAppeals.receivedAt),
          asc(priorAuthAppeals.appealId),
        )
        .limit(limit);
      return records.map(toAppealRow);
    });
  }

  async reconsider(
    appealId: string,
    reconsideration: Reconsideration,
    signed: SignedAction,
    options: ReconsiderOptions = {},
  ): Promise<ActionResult> {
    const checked = checkReconsideration(reconsideration, signed, options);
    return span('memory.appeals.reconsider', () =>
      this.act(appealId, checked.signed, options, async (tx, appeal, caseRow) => {
        checkInvolvement(appeal, checked.signed.reviewerId, checked.record.initialReviewerId);
        const next = reconsideredRow(appeal, caseRow, checked.record, checked.signed);
        await options.beforeCommit?.(next, caseRow);
        await this.write(tx, next);
        if (checked.record.kind !== 'reversal' || options.response === undefined) {
          return { row: next, caseRow };
        }
        await tx
          .update(priorAuthCases)
          .set({ response: options.response })
          .where(eq(priorAuthCases.caseId, caseRow.caseId));
        return { row: next, caseRow: { ...caseRow, response: structuredClone(options.response) } };
      }),
    );
  }

  async dismiss(
    appealId: string,
    dismissal: Dismissal,
    signed: SignedAction,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    const checked = checkDismissal(dismissal, signed);
    return span('memory.appeals.dismiss', () =>
      this.act(appealId, checked.signed, options, async (tx, appeal, caseRow) => {
        checkInvolvement(appeal, checked.signed.reviewerId);
        const next = dismissedRow(appeal, checked.dismissal, checked.signed);
        await options.beforeCommit?.(next, caseRow);
        await this.write(tx, next);
        return { row: next, caseRow };
      }),
    );
  }

  async forwardLapsed(now: Date, options: ForwardOptions = {}): Promise<ForwardedAppeal[]> {
    return span('memory.appeals.forward_lapsed', async () => {
      const lapsed = await this.db
        .select({ appealId: priorAuthAppeals.appealId })
        .from(priorAuthAppeals)
        .where(
          and(
            eq(priorAuthAppeals.status, 'filed'),
            lte(priorAuthAppeals.reconsiderationDueBy, now),
          ),
        )
        .orderBy(asc(priorAuthAppeals.reconsiderationDueBy), asc(priorAuthAppeals.appealId));

      const forwarded: ForwardedAppeal[] = [];
      for (const { appealId } of lapsed) {
        // Each under its own lock: a concurrent sweep, or a write that
        // forwarded it first, leaves it not filed, and this one passes over it.
        const next = await forwardOrReport(appealId, options, () =>
          this.db.transaction(async (tx): Promise<AppealRow | null> => {
            const [record] = await tx
              .select()
              .from(priorAuthAppeals)
              .where(eq(priorAuthAppeals.appealId, appealId))
              .for('update');
            if (record === undefined) return null;
            const appeal = toAppealRow(record);
            if (appeal.status !== 'filed') return null;
            const [caseRecord] = await tx
              .select()
              .from(priorAuthCases)
              .where(eq(priorAuthCases.caseId, appeal.caseId))
              .limit(1);
            if (caseRecord === undefined) throw new Error(`appeal ${appealId} has no case`);
            const caseRow = toCaseRow(caseRecord);
            const forward = lapsedRow(appeal, caseRow, now);
            await options.beforeCommit?.(forward, caseRow);
            await this.write(tx, forward);
            return forward;
          }),
        );
        if (next !== null) forwarded.push(forwardedOf(next));
      }
      return forwarded;
    });
  }

  /**
   * One action on one appeal, under both locks. A lapsed appeal is forwarded
   * and answered `lapsed`; a terminal one is `unchanged` or `conflict`; a
   * filed one runs `apply`.
   */
  private async act(
    appealId: string,
    signed: SignedAction,
    options: ActionOptions,
    apply: (
      tx: Transaction,
      appeal: AppealRow,
      caseRow: CaseRow,
    ) => Promise<{ row: AppealRow; caseRow: CaseRow }>,
  ): Promise<ActionResult> {
    if (!z.string().uuid().safeParse(appealId).success) return { outcome: 'not-found' };
    return this.db.transaction(async (tx): Promise<ActionResult> => {
      const [record] = await tx
        .select()
        .from(priorAuthAppeals)
        .where(eq(priorAuthAppeals.appealId, appealId))
        .for('update');
      if (record === undefined) return { outcome: 'not-found' };
      const appeal = toAppealRow(record);
      const [caseRecord] = await tx
        .select()
        .from(priorAuthCases)
        .where(eq(priorAuthCases.caseId, appeal.caseId))
        .for('no key update');
      if (caseRecord === undefined) throw new Error(`appeal ${appealId} has no case`);
      const caseRow = toCaseRow(caseRecord);

      const kind = classifyAction(appeal, signed.signature, signed.decidedAt);
      if (kind === 'unchanged' || kind === 'conflict')
        return { outcome: kind, row: appeal, caseRow };
      if (kind === 'lapse') {
        const next = lapsedRow(appeal, caseRow, signed.decidedAt);
        await options.beforeCommit?.(next, caseRow);
        await this.write(tx, next);
        return { outcome: 'lapsed', row: next, caseRow };
      }
      const result = await apply(tx, appeal, caseRow);
      return { outcome: 'recorded', ...result };
    });
  }

  private async write(tx: Transaction, next: AppealRow): Promise<void> {
    await tx
      .update(priorAuthAppeals)
      .set(actionColumns(next))
      .where(
        and(eq(priorAuthAppeals.appealId, next.appealId), eq(priorAuthAppeals.status, 'filed')),
      );
  }
}

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/**
 * Runs one lapse forward. A failure propagates without `onError`, and with
 * it is reported and counts as nothing forwarded, so the sweep goes on.
 */
export async function forwardOrReport(
  appealId: string,
  options: ForwardOptions,
  forward: () => Promise<AppealRow | null>,
): Promise<AppealRow | null> {
  if (options.onError === undefined) return forward();
  try {
    return await forward();
  } catch (error) {
    options.onError(appealId, error);
    return null;
  }
}

export function forwardedOf(row: AppealRow): ForwardedAppeal {
  if (row.forwardedAt === null || row.caseFileDigest === null) {
    throw new Error(`appeal ${row.appealId} is not forwarded`);
  }
  return {
    appealId: row.appealId,
    caseId: row.caseId,
    priority: row.priority,
    reconsiderationDueBy: row.reconsiderationDueBy,
    forwardedAt: row.forwardedAt,
    caseFileDigest: row.caseFileDigest,
  };
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
