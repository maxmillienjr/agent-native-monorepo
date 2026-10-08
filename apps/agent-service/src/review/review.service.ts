import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CaseRepository, CaseRow } from '@repo/memory-core';
import {
  PolicyCatalogue,
  compareCases,
  isOverdue,
  type Clock,
  type Policy,
  type QueueKey,
} from '@repo/prior-auth';
import type { CriterionFinding } from '@repo/determination';
import { withServiceSpan } from '@repo/telemetry';
import { CASE_REPOSITORY } from '../memory/memory.tokens.js';
import { PRIOR_AUTH_CLOCK } from '../fhir/prior-auth.service.js';

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

  constructor(
    @Inject(CASE_REPOSITORY) private readonly cases: CaseRepository,
    @Inject(PRIOR_AUTH_CLOCK) private readonly clock: Clock,
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
