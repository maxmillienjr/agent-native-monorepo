import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AppealRequestSchema,
  DismissalReasonSchema,
  FilerSchema,
  caseFileDigest,
  caseFileOf,
  type ActionResult,
  type AppealRepository,
  type AppealRow,
  type CaseRepository,
  type CaseRow,
  type Filer,
} from '@repo/memory-core';
import {
  PolicyCatalogue,
  compareCases,
  filingDeadline,
  isLapsed,
  loadPayer,
  readSubmission,
  reconsiderationDueBy,
  toReconsideredResponse,
  toResponseBundle,
  type Clock,
  type FhirBundle,
  type Payer,
  type QueueKey,
} from '@repo/prior-auth';
import {
  AdverseDeterminationRecordSchema,
  ClinicianAttestationSchema,
  type Reconsideration,
} from '@repo/determination';
// The one constructor for a reconsideration. Importable here because this
// file is outside src/agent/, where P3-A's lint rule forbids it.
import { InvolvedReviewerError, attestReconsideration } from '@repo/determination/clinician';
import { createLogger, errorType, withServiceSpan } from '@repo/telemetry';
import { APPEAL_REPOSITORY, CASE_REPOSITORY } from '../memory/memory.tokens.js';
import { PRIOR_AUTH_CLOCK } from '../fhir/prior-auth.service.js';
import { REVIEWER_REGISTRY, type RegisteredKey, type ReviewerRegistry } from './registry.js';
import { ReviewService, sameCredential, type CaseView } from './review.service.js';
import { appealSignedBytes, verifySignature } from './signature.js';

const logger = createLogger('review');

/**
 * The body of `POST /review/appeals`: staff intake of a request for
 * reconsideration, written or oral (§ 422.584(c)(1)). The filer's fields are
 * held to `FilerSchema` once assembled, which is where a treating physician's
 * standard filing without notice to the enrollee is refused.
 */
export const FileAppealBodySchema = z
  .object({
    caseId: z.string().min(1),
    filer: z
      .object({
        role: z.enum(['enrollee', 'representative', 'physician']),
        name: z.string(),
        identifier: z.object({ system: z.string(), value: z.string() }).strict().optional(),
      })
      .strict(),
    channel: z.enum(['written', 'oral']),
    expedite: z.object({ requested: z.boolean(), physicianSupport: z.boolean() }).strict(),
    enrolleeNotified: z.literal(true).optional(),
    noticeReceivedAt: z.string().optional(),
    statement: z.string(),
    evidence: z.record(z.unknown()).optional(),
  })
  .strict();

const SignedEnvelope = {
  reviewerKeyId: z.string().min(1),
  signature: z.string().min(1),
};

/** The body of `POST /review/appeals/:appealId/reconsideration`. `reconsideration` is what was signed. */
export const ReconsiderationBodySchema = z
  .object({
    reconsideration: z
      .object({
        kind: z.enum(['reversal', 'affirmation']),
        explanation: z.string().trim().min(1),
        goodCauseFound: z.boolean(),
        attestation: ClinicianAttestationSchema,
      })
      .strict(),
    ...SignedEnvelope,
  })
  .strict();

/** The body of `POST /review/appeals/:appealId/dismissal`. `dismissal` is what was signed. */
export const DismissalBodySchema = z
  .object({
    dismissal: z
      .object({
        reason: DismissalReasonSchema,
        explanation: z.string().trim().min(1),
        attestation: ClinicianAttestationSchema,
      })
      .strict(),
    ...SignedEnvelope,
  })
  .strict();

/**
 * One filed appeal in the queue: its clock and what identifies it, and
 * nothing the agent found, for the reason P3-E's queue carries none.
 */
export interface AppealQueueItem {
  readonly appealId: string;
  readonly caseId: string;
  readonly priority: 'expedited' | 'standard';
  readonly receivedAt: string;
  readonly reconsiderationDueBy: string;
  /** Computed from the clock when read, so an appeal shows lapsed before any sweep has run. */
  readonly lapsed: boolean;
  readonly timely: boolean;
  readonly hcpcs: string;
}

/**
 * One appeal, as the reconsidering physician reads it: the case view, with
 * the agent's findings and the initial denial; the filing and its evidence;
 * whether it was timely and whether it has lapsed; what has been decided on
 * it; and what to sign.
 */
export interface AppealView extends AppealQueueItem {
  readonly status: AppealRow['status'];
  readonly filingDeadline: string;
  readonly filer: Filer;
  readonly request: Record<string, unknown>;
  readonly initialReviewerId: string;
  /** The credential types that may reconsider under the case's policy: physicians only. */
  readonly reconsiderationCredentials: readonly string[];
  readonly case: CaseView;
  readonly reconsideration: {
    readonly record: NonNullable<AppealRow['reconsideration']>;
    readonly reviewerId: string;
    readonly reviewerKeyId: string;
    readonly decidedAt: string;
  } | null;
  readonly dismissal: {
    readonly record: NonNullable<AppealRow['dismissal']>;
    readonly reviewerId: string;
    readonly reviewerKeyId: string;
    readonly decidedAt: string;
  } | null;
  /** A record, not a delivery: no independent-entity system is contacted. */
  readonly forward: {
    readonly reason: NonNullable<AppealRow['forwardReason']>;
    readonly forwardedAt: string;
    readonly caseFileDigest: string;
  } | null;
  /** What a reconsideration or a dismissal signs. The service verifies; it never signs. */
  readonly signing: {
    readonly algorithm: 'Ed25519';
    readonly encoding: 'base64url';
    readonly payload: 'canonicalJson({ action, appealId, body, runId })';
    readonly actions: readonly ['reconsideration', 'dismissal'];
    readonly appealId: string;
    readonly runId: string;
  };
}

/** `GET /review/appeals/:appealId/case-file`. */
export interface CaseFileView {
  readonly caseFile: Record<string, unknown>;
  /** The SHA-256 of the case file as it reads now. */
  readonly digest: string;
  /** The digest stored when the appeal was forwarded, or null if it was not. */
  readonly forwardedDigest: string | null;
}

/**
 * Appeals (P3-F): Medicare Advantage reconsiderations of a denied case,
 * beside the review queue that made the denial.
 *
 * The non-involved reviewer of § 422.590(h)(1) is enforced three times: the
 * branded `Reconsideration` whose one constructor refuses the initial
 * reviewer, the check in this service before anything is written, and the
 * foreign key and CHECK on `prior_auth_appeals` that hold whatever writes
 * the row.
 */
@Injectable()
export class AppealService {
  private readonly catalogue: PolicyCatalogue = PolicyCatalogue.load();
  private readonly payer: Payer = loadPayer();

  constructor(
    @Inject(APPEAL_REPOSITORY) private readonly appeals: AppealRepository,
    @Inject(CASE_REPOSITORY) private readonly cases: CaseRepository,
    @Inject(PRIOR_AUTH_CLOCK) private readonly clock: Clock,
    @Inject(REVIEWER_REGISTRY) private readonly registry: ReviewerRegistry | null,
    @Inject(ReviewService) private readonly review: ReviewService,
  ) {}

  /**
   * Records a request for reconsideration of a denied case.
   *
   * `400` for a body that does not parse, including a treating physician's
   * standard filing without notice to the enrollee; `404` for an unknown case;
   * `422` for a case that is not decided with a denial; `409` when the case
   * already has an appeal that is not dismissed. A late filing is recorded
   * with `timely: false`, never refused: § 422.582(c) lets the filer ask for
   * good cause in the same request, and a person decides.
   */
  file(raw: unknown): Promise<AppealView> {
    return withServiceSpan('review.appeal.file', async (span) => {
      const parsed = FileAppealBodySchema.safeParse(raw);
      if (!parsed.success) throw validationError(parsed.error);
      const body = parsed.data;
      const filer = FilerSchema.safeParse({
        ...body.filer,
        channel: body.channel,
        expedite: body.expedite,
        ...(body.enrolleeNotified === undefined ? {} : { enrolleeNotified: body.enrolleeNotified }),
        ...(body.noticeReceivedAt === undefined ? {} : { noticeReceivedAt: body.noticeReceivedAt }),
      });
      if (!filer.success) throw validationError(filer.error);
      const request = {
        statement: body.statement,
        ...(body.evidence === undefined ? {} : { evidence: body.evidence }),
      };
      const requestParsed = AppealRequestSchema.safeParse(request);
      if (!requestParsed.success) throw validationError(requestParsed.error);

      const caseRow = await this.cases.get(body.caseId);
      if (caseRow === null) throw new NotFoundException(`no case ${body.caseId}`);
      span.setAttribute('prior_auth.case_id', caseRow.caseId);
      if (
        caseRow.status !== 'decided' ||
        caseRow.decidedAt === null ||
        !AdverseDeterminationRecordSchema.safeParse(caseRow.determination).success
      ) {
        throw notAppealable(caseRow);
      }

      const now = this.clock.now();
      const priority = body.expedite.requested ? 'expedited' : 'standard';
      const deadline = filingDeadline({
        determinationDate: caseRow.decidedAt,
        ...(filer.data.noticeReceivedAt === undefined
          ? {}
          : { noticeReceivedAt: new Date(filer.data.noticeReceivedAt) }),
      });
      const result = await this.appeals.file({
        appealId: randomUUID(),
        caseId: caseRow.caseId,
        priority,
        filer: filer.data,
        receivedAt: now,
        filingDeadline: deadline,
        timely: now.getTime() <= deadline.getTime(),
        reconsiderationDueBy: reconsiderationDueBy(now, priority),
        request,
      });

      span.setAttribute('review.outcome', result.outcome);
      if (result.outcome === 'not-found') throw new NotFoundException(`no case ${body.caseId}`);
      if (result.outcome === 'not-appealable') throw notAppealable(caseRow);
      if (result.outcome === 'already-open') {
        throw new ConflictException(
          `Case ${caseRow.caseId} already has appeal ${result.row.appealId}, which is ${result.row.status}.`,
        );
      }
      span.setAttribute('prior_auth.appeal_id', result.row.appealId);
      span.setAttribute('prior_auth.priority', result.row.priority);
      span.setAttribute('prior_auth.timely', result.row.timely);
      logger.info({
        msg: 'review.appeal.filed',
        appealId: result.row.appealId,
        caseId: caseRow.caseId,
        priority: result.row.priority,
        timely: result.row.timely,
      });
      return this.viewOf(result.row);
    });
  }

  /**
   * Filed appeals, earliest reconsideration deadline first. Sorted again with
   * P3-E's `compareCases`, whose only input is a `QueueKey`, so the order is
   * the clock's by type and not only by query.
   */
  queue(limit: number): Promise<AppealQueueItem[]> {
    return withServiceSpan('review.appeal.queue', async (span) => {
      const now = this.clock.now();
      const rows = await this.appeals.queue(limit);
      const byId = new Map(rows.map((row) => [row.appealId, row]));
      const keys: QueueKey[] = rows.map((row) => ({
        caseId: row.appealId,
        receivedAt: row.receivedAt,
        decisionDueBy: row.reconsiderationDueBy,
      }));
      const items: AppealQueueItem[] = [];
      for (const key of keys.sort(compareCases)) {
        const row = byId.get(key.caseId);
        if (row === undefined) throw new Error(`appeal ${key.caseId} left the queue mid-read`);
        const caseRow = await this.cases.get(row.caseId);
        if (caseRow === null) throw new Error(`appeal ${row.appealId} has no case`);
        items.push(queueItem(row, caseRow, now));
      }
      span.setAttribute('review.appeal_count', items.length);
      span.setAttribute('review.lapsed_count', items.filter((item) => item.lapsed).length);
      return items;
    });
  }

  view(appealId: string): Promise<AppealView> {
    return withServiceSpan('review.appeal.view', async (span) => {
      const row = await this.appeals.get(appealId);
      if (row === null) throw new NotFoundException(`no appeal ${appealId}`);
      span.setAttribute('prior_auth.appeal_id', row.appealId);
      span.setAttribute('prior_auth.appeal_status', row.status);
      return this.viewOf(row);
    });
  }

  /**
   * The case file the plan forwards (§ 422.590(a)(2)), rebuilt from the two
   * rows, with its digest and the one stored at the forward. The two are equal
   * for a forwarded appeal unless a row was edited since.
   */
  caseFile(appealId: string): Promise<CaseFileView> {
    return withServiceSpan('review.appeal.case_file', async (span) => {
      const row = await this.appeals.get(appealId);
      if (row === null) throw new NotFoundException(`no appeal ${appealId}`);
      span.setAttribute('prior_auth.appeal_id', row.appealId);
      const caseRow = await this.cases.get(row.caseId);
      if (caseRow === null) throw new Error(`appeal ${row.appealId} has no case`);
      const caseFile = caseFileOf(row, caseRow);
      return { caseFile, digest: caseFileDigest(caseFile), forwardedDigest: row.caseFileDigest };
    });
  }

  /**
   * A physician's signed reconsideration, verified and recorded once.
   *
   * P3-E's checks in P3-E's order: a registry or `503`; the body parses or
   * `400`; the appeal exists or `404`; the key is active or `401`; the
   * signature verifies over this appeal's bytes or `401`; the attestation is
   * the key's reviewer and credential or `401`; the caller is the key's
   * principal, when both are known, or `403`. Then this PRD's:
   *
   * - the reviewer did not make the denial, or `403` (§ 422.590(h)(1));
   * - the credential type is one the policy lists for reconsideration, all
   *   physicians, or `403` (§ 422.590(h)(2));
   * - an untimely appeal is reconsidered only with `goodCauseFound`, or `400`.
   *
   * A reversal answers `200` with the approval now in force on the case; an
   * affirmation answers `200` with the denial still in force, and the appeal
   * forwarded. `409` for an appeal decided otherwise, or past its deadline,
   * which this request forwards as deemed affirmed (§ 422.590(d)). A store
   * failure is `503`, and the appeal stays filed.
   */
  reconsider(appealId: string, raw: unknown, principal: string | undefined): Promise<FhirBundle> {
    return withServiceSpan('review.appeal.reconsideration', async (span) => {
      const registry = this.requireRegistry();
      const parsed = ReconsiderationBodySchema.safeParse(raw);
      if (!parsed.success) throw validationError(parsed.error);
      const body = parsed.data;
      span.setAttribute('prior_auth.reconsideration', body.reconsideration.kind);

      const { appeal, caseRow, key, now } = await this.verified(
        appealId,
        'reconsideration',
        body.reconsideration,
        body,
        registry,
        principal,
      );
      span.setAttribute('prior_auth.appeal_id', appeal.appealId);
      span.setAttribute('prior_auth.case_id', appeal.caseId);

      const { attestation } = body.reconsideration;
      const policy = this.catalogue.forCode(caseRow.hcpcs);
      if (
        policy === undefined ||
        !policy.reconsiderationCredentials.includes(attestation.credential.type)
      ) {
        throw new ForbiddenException(
          `A ${attestation.credential.type} credential is not one the policy for ${caseRow.hcpcs} ` +
            'accepts for a reconsideration, which a physician makes (42 CFR § 422.590(h)(2)).',
        );
      }
      if (appeal.status === 'filed' && !appeal.timely && !body.reconsideration.goodCauseFound) {
        throw new BadRequestException(
          'The appeal was filed after the filing deadline, so it is reconsidered only with ' +
            'goodCauseFound: true (42 CFR § 422.582(c)); otherwise dismiss it as untimely.',
        );
      }

      const initial = AdverseDeterminationRecordSchema.parse(caseRow.determination);
      let reconsideration: Reconsideration;
      try {
        reconsideration = attestReconsideration(
          initial,
          {
            kind: body.reconsideration.kind,
            explanation: body.reconsideration.explanation,
            goodCauseFound: body.reconsideration.goodCauseFound,
          },
          attestation,
        );
      } catch (error) {
        if (error instanceof InvolvedReviewerError) throw new ForbiddenException(error.message);
        throw error;
      }

      const response =
        reconsideration.kind === 'reversal'
          ? this.reversalResponse(caseRow, reconsideration, now)
          : undefined;
      let result: ActionResult;
      try {
        result = await this.appeals.reconsider(
          appeal.appealId,
          reconsideration,
          {
            reviewerId: key.entry.reviewerId,
            reviewerKeyId: key.entry.reviewerKeyId,
            signature: body.signature,
            decidedAt: now,
          },
          response === undefined ? {} : { response },
        );
      } catch (error) {
        throw storeFailure('reconsideration', appeal.appealId, error);
      }

      const recorded = answered(result, appealId, span);
      logger.info({
        msg: 'review.appeal.reconsideration',
        appealId: recorded.row.appealId,
        outcome: result.outcome,
        kind: reconsideration.kind,
      });
      return recorded.caseRow.response as unknown as FhirBundle;
    });
  }

  /**
   * A signed dismissal (§ 422.582(f)). Any active registered key, by someone
   * other than the reviewer who denied: § 422.590(h) binds the
   * reconsideration, and applying it to a dismissal too is one rule instead of
   * two, for an action that is adverse to the filer. An `untimely` dismissal
   * of a timely appeal is `400`. Otherwise as `reconsider`, answering the
   * appeal view.
   */
  dismiss(appealId: string, raw: unknown, principal: string | undefined): Promise<AppealView> {
    return withServiceSpan('review.appeal.dismissal', async (span) => {
      const registry = this.requireRegistry();
      const parsed = DismissalBodySchema.safeParse(raw);
      if (!parsed.success) throw validationError(parsed.error);
      const body = parsed.data;

      const { appeal, key, now } = await this.verified(
        appealId,
        'dismissal',
        body.dismissal,
        body,
        registry,
        principal,
      );
      span.setAttribute('prior_auth.appeal_id', appeal.appealId);
      span.setAttribute('prior_auth.case_id', appeal.caseId);
      if (appeal.status === 'filed' && body.dismissal.reason === 'untimely' && appeal.timely) {
        throw new BadRequestException(
          'The appeal was filed in time, so it cannot be dismissed as untimely.',
        );
      }

      let result: ActionResult;
      try {
        result = await this.appeals.dismiss(appeal.appealId, body.dismissal, {
          reviewerId: key.entry.reviewerId,
          reviewerKeyId: key.entry.reviewerKeyId,
          signature: body.signature,
          decidedAt: now,
        });
      } catch (error) {
        throw storeFailure('dismissal', appeal.appealId, error);
      }
      const recorded = answered(result, appealId, span);
      logger.info({
        msg: 'review.appeal.dismissal',
        appealId: recorded.row.appealId,
        outcome: result.outcome,
        reason: body.dismissal.reason,
      });
      return this.viewOf(recorded.row);
    });
  }

  private requireRegistry(): ReviewerRegistry {
    if (this.registry === null) {
      throw new ServiceUnavailableException(
        'No reviewer registry is configured (REVIEWER_REGISTRY), so no appeal action can be verified.',
      );
    }
    return this.registry;
  }

  /**
   * The checks a reconsideration and a dismissal share, in P3-E's order,
   * ending with the one § 422.590(h)(1) adds: the signer is not the reviewer
   * who made the denial.
   */
  private async verified(
    appealId: string,
    action: 'reconsideration' | 'dismissal',
    signedBody: { readonly attestation: z.infer<typeof ClinicianAttestationSchema> },
    envelope: { readonly reviewerKeyId: string; readonly signature: string },
    registry: ReviewerRegistry,
    principal: string | undefined,
  ): Promise<{ appeal: AppealRow; caseRow: CaseRow; key: RegisteredKey; now: Date }> {
    const appeal = await this.appeals.get(appealId);
    if (appeal === null) throw new NotFoundException(`no appeal ${appealId}`);
    const caseRow = await this.cases.get(appeal.caseId);
    if (caseRow === null) throw new Error(`appeal ${appeal.appealId} has no case`);

    const now = this.clock.now();
    const key = registry.active(envelope.reviewerKeyId, now);
    if (key === undefined) {
      throw new UnauthorizedException('The reviewer key is not registered, or is revoked.');
    }
    const bytes = appealSignedBytes({
      action,
      appealId: appeal.appealId,
      caseId: appeal.caseId,
      body: signedBody,
    });
    if (!verifySignature(key.publicKey, bytes, envelope.signature)) {
      throw new UnauthorizedException(
        `The signature does not verify as a ${action} of this appeal.`,
      );
    }
    const { attestation } = signedBody;
    if (
      attestation.reviewerId !== key.entry.reviewerId ||
      !sameCredential(attestation.credential, key.entry.credential)
    ) {
      throw new UnauthorizedException(
        'The attestation does not name the reviewer and credential the key is registered to.',
      );
    }
    if (
      key.entry.principal !== undefined &&
      principal !== undefined &&
      principal !== key.entry.principal
    ) {
      throw new ForbiddenException('This key may not be used by the authenticated caller.');
    }
    if (key.entry.reviewerId === appeal.initialReviewerId) {
      throw new ForbiddenException(
        `${key.entry.reviewerId} made the determination under reconsideration, and an appeal is ` +
          'acted on by someone not involved in it (42 CFR § 422.590(h)(1)).',
      );
    }
    return { appeal, caseRow, key, now };
  }

  /** The approval a reversal puts in force, built as a determination's response is. */
  private reversalResponse(
    caseRow: CaseRow,
    reconsideration: Reconsideration,
    now: Date,
  ): Record<string, unknown> {
    const submission = readSubmission(caseRow.request, this.payer);
    if (submission.kind !== 'ok') {
      throw new Error(`case ${caseRow.caseId} holds a request that no longer reads`);
    }
    const claimResponse = toReconsideredResponse(
      submission.request.claim,
      reconsideration,
      this.catalogue.forCode(caseRow.hcpcs),
      { decidedAt: now, caseId: caseRow.caseId },
    );
    const bundle = toResponseBundle(submission.request.bundle, claimResponse, {
      caseId: caseRow.caseId,
      respondedAt: now,
    });
    return bundle as unknown as Record<string, unknown>;
  }

  private async viewOf(row: AppealRow): Promise<AppealView> {
    const caseView = await this.review.view(row.caseId);
    const caseRow = await this.cases.get(row.caseId);
    if (caseRow === null) throw new Error(`appeal ${row.appealId} has no case`);
    const signer =
      row.reviewerId === null || row.reviewerKeyId === null || row.decidedAt === null
        ? null
        : {
            reviewerId: row.reviewerId,
            reviewerKeyId: row.reviewerKeyId,
            decidedAt: row.decidedAt.toISOString(),
          };
    return {
      ...queueItem(row, caseRow, this.clock.now()),
      status: row.status,
      filingDeadline: row.filingDeadline.toISOString(),
      filer: row.filer,
      request: row.request,
      initialReviewerId: row.initialReviewerId,
      reconsiderationCredentials:
        this.catalogue.forCode(caseRow.hcpcs)?.reconsiderationCredentials ?? [],
      case: caseView,
      reconsideration:
        row.reconsideration === null || signer === null
          ? null
          : { record: row.reconsideration, ...signer },
      dismissal:
        row.dismissal === null || signer === null ? null : { record: row.dismissal, ...signer },
      forward:
        row.forwardReason === null || row.forwardedAt === null || row.caseFileDigest === null
          ? null
          : {
              reason: row.forwardReason,
              forwardedAt: row.forwardedAt.toISOString(),
              caseFileDigest: row.caseFileDigest,
            },
      signing: {
        algorithm: 'Ed25519',
        encoding: 'base64url',
        payload: 'canonicalJson({ action, appealId, body, runId })',
        actions: ['reconsideration', 'dismissal'],
        appealId: row.appealId,
        runId: row.caseId,
      },
    };
  }
}

function queueItem(row: AppealRow, caseRow: CaseRow, now: Date): AppealQueueItem {
  return {
    appealId: row.appealId,
    caseId: row.caseId,
    priority: row.priority,
    receivedAt: row.receivedAt.toISOString(),
    reconsiderationDueBy: row.reconsiderationDueBy.toISOString(),
    lapsed: row.status === 'filed' && isLapsed(row, now),
    timely: row.timely,
    hcpcs: caseRow.hcpcs,
  };
}

function validationError(error: z.ZodError): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Validation Error',
    issues: error.issues,
  });
}

function notAppealable(caseRow: CaseRow): UnprocessableEntityException {
  const what =
    caseRow.status === 'decided'
      ? `decided with ${caseRow.determination?.kind ?? 'no determination'}`
      : caseRow.status;
  return new UnprocessableEntityException(
    `Case ${caseRow.caseId} is ${what}. Only a case decided with a denial can be reconsidered here; ` +
      'an appeal of a decision not made in time (42 CFR § 422.568(f)) is not built.',
  );
}

function storeFailure(action: string, appealId: string, error: unknown): HttpException {
  logger.error({
    msg: 'review.appeal.store_failed',
    action,
    appealId,
    errorType: errorType(error),
  });
  return new ServiceUnavailableException(
    `The ${action} could not be recorded, so it was not issued. The appeal is still filed.`,
  );
}

/** The recorded rows of an action, or the status its outcome answers. */
function answered(
  result: ActionResult,
  appealId: string,
  span: { setAttribute(key: string, value: string): unknown },
): { row: AppealRow; caseRow: CaseRow } {
  span.setAttribute('review.outcome', result.outcome);
  if (result.outcome === 'not-found') throw new NotFoundException(`no appeal ${appealId}`);
  span.setAttribute('prior_auth.appeal_status', result.row.status);
  if (result.outcome === 'lapsed') {
    span.setAttribute('prior_auth.forward_reason', 'deadline-lapsed');
    throw new ConflictException(
      'The reconsideration deadline has passed. Under 42 CFR § 422.590(d) that is an affirmation, ' +
        'and the appeal has been forwarded to the independent entity; nothing else was recorded.',
    );
  }
  if (result.outcome === 'conflict') {
    throw new ConflictException(
      result.row.forwardReason === 'deadline-lapsed'
        ? 'The appeal lapsed and was forwarded to the independent entity as deemed affirmed.'
        : `The appeal was already ${result.row.status} by a different action.`,
    );
  }
  return { row: result.row, caseRow: result.caseRow };
}
