import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import type { CaseRepository, CaseRow } from '@repo/memory-core';
import {
  PolicyCatalogue,
  compareCases,
  isOverdue,
  loadPayer,
  readSubmission,
  toDeterminationResponse,
  toResponseBundle,
  type Clock,
  type FhirBundle,
  type Payer,
  type Policy,
  type QueueKey,
} from '@repo/prior-auth';
import {
  ClinicianApprovalSchema,
  ClinicianAttestationSchema,
  type AdverseDetermination,
  type ClinicianApproval,
  type CriterionFinding,
} from '@repo/determination';
// The one constructor for an adverse determination. Importable here because
// this file is outside src/agent/, where P3-A's lint rule forbids it.
import { attestAdverseDetermination } from '@repo/determination/clinician';
import { createLogger, errorType, withServiceSpan } from '@repo/telemetry';
import { CASE_REPOSITORY } from '../memory/memory.tokens.js';
import { PRIOR_AUTH_CLOCK } from '../fhir/prior-auth.service.js';
import { REVIEWER_REGISTRY, type ReviewerRegistry } from './registry.js';
import { signedBytes, verifySignature } from './signature.js';

const logger = createLogger('review');

/**
 * The body of `POST /review/cases/:caseId/determination`.
 *
 * `partial-approval` parses so that it can be refused with 422 by name rather
 * than as a malformed body: P3-A types it, and it has no statement of what was
 * approved. A denial's `specificReason` must be non-blank, because CMS-0057-F
 * requires a specific reason for every denial. Every object is strict, so the
 * determination that is verified is exactly the one that was signed.
 */
export const DeterminationBodySchema = z
  .object({
    determination: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('clinician-approval'), attestation: ClinicianAttestationSchema })
        .strict(),
      z
        .object({
          kind: z.literal('denial'),
          specificReason: z.string().trim().min(1),
          attestation: ClinicianAttestationSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('partial-approval'),
          specificReason: z.string(),
          attestation: ClinicianAttestationSchema,
        })
        .strict(),
    ]),
    recommendationSeq: z.number().int().nonnegative().nullable(),
    reviewerKeyId: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();
export type DeterminationBody = z.infer<typeof DeterminationBodySchema>;

/**
 * One pended case in the queue. It carries the clock and what identifies the
 * case, and nothing the agent found: the queue's order is the clock's alone
 * (P3-E), and a list that showed findings beside it would invite the reader to
 * re-sort by them.
 */
export interface QueueItem {
  readonly caseId: string;
  readonly priority: 'expedited' | 'standard';
  readonly receivedAt: string;
  readonly decisionDueBy: string;
  /** Computed from the clock when read, so a case shows overdue before any sweep has run. */
  readonly overdue: boolean;
  readonly overdueFlaggedAt: string | null;
  readonly hcpcs: string;
}

/**
 * One case, as a reviewer reads it before deciding.
 *
 * This is the one place the model's per-criterion rationale is served, which
 * is where P3-D said the reviewer reads it. Each finding shows its status, the
 * evidence it cites and its rationale, and there is no suggested outcome: P3-A
 * designed the referral without one, because a referral labelled "recommend
 * deny" asks the reviewer to confirm the tool.
 */
export interface CaseView extends QueueItem {
  readonly status: CaseRow['status'];
  readonly policy: {
    readonly id: string;
    readonly version: string;
    readonly title: string;
    readonly criteria: Policy['criteria'];
    /** The credential types that may deny under this policy. */
    readonly reviewerCredentials: readonly string[];
  } | null;
  readonly findings: readonly CriterionFinding[];
  /** The request bundle as `$submit` received it. */
  readonly request: Record<string, unknown>;
  /** The response bundle in force: what `$inquire` returns for this case now. */
  readonly response: Record<string, unknown>;
  readonly decision: {
    readonly determination: NonNullable<CaseRow['determination']>;
    readonly reviewerId: string;
    readonly reviewerKeyId: string;
    readonly decidedAt: string;
  } | null;
  /** What a determination on this case signs. The service verifies; it never signs. */
  readonly signing: {
    readonly algorithm: 'Ed25519';
    readonly encoding: 'base64url';
    readonly payload: 'canonicalJson({ determination, recommendationSeq, runId })';
    readonly runId: string;
    readonly recommendationSeq: number | null;
  };
}

/**
 * The clinician review surface's read side (P3-E): the queue and one case.
 * The determination route is beside it in this class.
 */
@Injectable()
export class ReviewService {
  private readonly catalogue: PolicyCatalogue = PolicyCatalogue.load();
  private readonly payer: Payer = loadPayer();

  constructor(
    @Inject(CASE_REPOSITORY) private readonly cases: CaseRepository,
    @Inject(PRIOR_AUTH_CLOCK) private readonly clock: Clock,
    @Inject(REVIEWER_REGISTRY) private readonly registry: ReviewerRegistry | null,
  ) {}

  /**
   * Pended cases, earliest deadline first. The store returns them in that
   * order; they are sorted again with `compareCases`, whose only input is a
   * `QueueKey`, so the order this route serves is the clock's by type and not
   * only by query.
   */
  queue(limit: number): Promise<QueueItem[]> {
    return withServiceSpan('review.queue', async (span) => {
      const now = this.clock.now();
      const rows = await this.cases.queue(limit);
      const byId = new Map(rows.map((row) => [row.caseId, row]));
      const keys: QueueKey[] = rows.map(({ caseId, receivedAt, decisionDueBy }) => ({
        caseId,
        receivedAt,
        decisionDueBy,
      }));
      const items = keys.sort(compareCases).map((key) => {
        const row = byId.get(key.caseId);
        if (row === undefined) throw new Error(`case ${key.caseId} left the queue mid-read`);
        return queueItem(row, now);
      });
      span.setAttribute('review.case_count', items.length);
      span.setAttribute('review.overdue_count', items.filter((item) => item.overdue).length);
      return items;
    });
  }

  view(caseId: string): Promise<CaseView> {
    return withServiceSpan('review.case', async (span) => {
      const row = await this.cases.get(caseId);
      if (row === null) throw new NotFoundException(`no case ${caseId}`);
      span.setAttribute('prior_auth.case_id', row.caseId);
      span.setAttribute('prior_auth.status', row.status);

      const policy = this.catalogue.forCode(row.hcpcs);
      return {
        ...queueItem(row, this.clock.now()),
        status: row.status,
        policy:
          policy === undefined
            ? null
            : {
                id: policy.id,
                version: policy.version,
                title: policy.title,
                criteria: policy.criteria,
                reviewerCredentials: policy.reviewerCredentials,
              },
        findings: row.disposition.kind === 'refer-to-clinician' ? row.disposition.findings : [],
        request: row.request,
        response: row.response,
        decision:
          row.determination === null ||
          row.reviewerId === null ||
          row.reviewerKeyId === null ||
          row.decidedAt === null
            ? null
            : {
                determination: row.determination,
                reviewerId: row.reviewerId,
                reviewerKeyId: row.reviewerKeyId,
                decidedAt: row.decidedAt.toISOString(),
              },
        signing: {
          algorithm: 'Ed25519',
          encoding: 'base64url',
          payload: 'canonicalJson({ determination, recommendationSeq, runId })',
          runId: row.caseId,
          recommendationSeq: row.recommendationSeq,
        },
      };
    });
  }

  /**
   * A clinician's determination on a pended case, verified and recorded once.
   *
   * The checks, in order, each answered before anything is written:
   *
   * 1. A registry is configured, or 503: nothing could be verified.
   * 2. The body parses, or 400. A blank `specificReason` is a 400.
   * 3. It is not a partial approval, or 422.
   * 4. The case exists, or 404, and `recommendationSeq` is the case's, or 400.
   * 5. The key is registered and not revoked, or 401.
   * 6. The signature verifies over the case's bytes, or 401. A signature for
   *    another case fails here, because the case id is inside the bytes.
   * 7. The attestation claims the reviewer and the credential the key is
   *    registered to, or 401.
   * 8. When P5-A authenticates the caller and the key names a principal, the
   *    caller is that principal, or 403.
   * 9. For a denial, the credential type is one the case's policy lists, or
   *    403: § 422.566(d)'s "appropriate" expertise, reduced to a type match.
   *
   * Only then is a denial minted, through `attestAdverseDetermination`, and
   * the case decided under the store's lock: 200 with the new response, 200
   * with the stored response for a byte-identical retry, 409 for any other
   * decision on a decided or automatically approved case. A store failure is
   * 503 and the case stays pended.
   */
  determine(caseId: string, raw: unknown, principal: string | undefined): Promise<FhirBundle> {
    return withServiceSpan('review.determination', async (span) => {
      if (this.registry === null) {
        throw new ServiceUnavailableException(
          'No reviewer registry is configured (REVIEWER_REGISTRY), so no determination can be verified.',
        );
      }

      const parsed = DeterminationBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Validation Error',
          issues: parsed.error.issues,
        });
      }
      const body = parsed.data;
      span.setAttribute('prior_auth.determination', body.determination.kind);
      if (body.determination.kind === 'partial-approval') {
        throw new UnprocessableEntityException(
          'A partial approval carries no statement of what was approved, so it cannot be issued.',
        );
      }

      const row = await this.cases.get(caseId);
      if (row === null) throw new NotFoundException(`no case ${caseId}`);
      span.setAttribute('prior_auth.case_id', row.caseId);
      if (body.recommendationSeq !== row.recommendationSeq) {
        throw new BadRequestException(
          "recommendationSeq is not the case's; read it from GET /review/cases/:caseId.",
        );
      }

      const now = this.clock.now();
      const key = this.registry.active(body.reviewerKeyId, now);
      if (key === undefined) {
        throw new UnauthorizedException('The reviewer key is not registered, or is revoked.');
      }
      const bytes = signedBytes({
        determination: body.determination,
        recommendationSeq: body.recommendationSeq,
        caseId: row.caseId,
      });
      if (!verifySignature(key.publicKey, bytes, body.signature)) {
        throw new UnauthorizedException('The signature does not verify for this case.');
      }
      const { attestation } = body.determination;
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

      const policy = this.catalogue.forCode(row.hcpcs);
      let determination: ClinicianApproval | AdverseDetermination;
      if (body.determination.kind === 'denial') {
        if (
          policy === undefined ||
          !policy.reviewerCredentials.includes(attestation.credential.type)
        ) {
          throw new ForbiddenException(
            `A ${attestation.credential.type} credential is not one the policy for ` +
              `${row.hcpcs} accepts for a denial.`,
          );
        }
        determination = attestAdverseDetermination(
          { kind: 'denial', specificReason: body.determination.specificReason },
          attestation,
        );
      } else {
        determination = ClinicianApprovalSchema.parse(body.determination);
      }

      const submission = readSubmission(row.request, this.payer);
      if (submission.kind !== 'ok') {
        throw new Error(`case ${row.caseId} holds a request that no longer reads`);
      }
      const claimResponse = toDeterminationResponse(
        submission.request.claim,
        determination,
        policy,
        {
          decidedAt: now,
          caseId: row.caseId,
        },
      );
      const response = toResponseBundle(submission.request.bundle, claimResponse, {
        caseId: row.caseId,
        respondedAt: now,
      });

      let result: Awaited<ReturnType<CaseRepository['decide']>>;
      try {
        result = await this.cases.decide(row.caseId, {
          determination,
          reviewerId: key.entry.reviewerId,
          reviewerKeyId: key.entry.reviewerKeyId,
          signature: body.signature,
          decidedAt: now,
          response: response as unknown as Record<string, unknown>,
        });
      } catch (error) {
        logger.error({
          msg: 'review.decide.failed',
          caseId: row.caseId,
          errorType: errorType(error),
        });
        throw new ServiceUnavailableException(
          'The determination could not be recorded, so it was not issued. The case is still pended.',
        );
      }

      span.setAttribute('review.outcome', result.outcome);
      if (result.outcome === 'not-found') throw new NotFoundException(`no case ${caseId}`);
      if (result.outcome === 'conflict') {
        throw new ConflictException(
          result.row.status === 'decided'
            ? 'The case was decided with a different determination.'
            : 'The case was approved by automated review and is not pended.',
        );
      }

      const decidedAt = result.row.decidedAt ?? now;
      const within = decidedAt.getTime() - result.row.receivedAt.getTime();
      span.setAttribute('prior_auth.decided_within_ms', within);
      span.setAttribute('prior_auth.on_time', !isOverdue(result.row, decidedAt));
      logger.info({
        msg: 'review.determination',
        caseId: row.caseId,
        outcome: result.outcome,
        kind: determination.kind,
      });
      return result.row.response as unknown as FhirBundle;
    });
  }
}

/** Two credentials are the same credential. */
function sameCredential(
  a: { readonly type: string; readonly jurisdiction: string },
  b: { readonly type: string; readonly jurisdiction: string },
): boolean {
  return a.type === b.type && a.jurisdiction === b.jurisdiction;
}

function queueItem(row: CaseRow, now: Date): QueueItem {
  return {
    caseId: row.caseId,
    priority: row.priority,
    receivedAt: row.receivedAt.toISOString(),
    decisionDueBy: row.decisionDueBy.toISOString(),
    overdue: row.status === 'pended' && isOverdue(row, now),
    overdueFlaggedAt: row.overdueFlaggedAt?.toISOString() ?? null,
    hcpcs: row.hcpcs,
  };
}
