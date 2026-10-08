import { z } from 'zod';
import {
  AdverseDeterminationRecordSchema,
  AgentDispositionSchema,
  ClinicianApprovalSchema,
  ReconsiderationRecordSchema,
  type AdverseDetermination,
  type AgentDisposition,
  type ClinicianApproval,
  type Reconsideration,
} from '@repo/determination';
import type { FhirBundle, PasClaim, PasClaimResponse } from './fhir/resources.js';
import type { ReferralReason } from './disposition.js';
import type { Policy } from './policy.js';
import { resolveReference } from './request.js';
import { HTEST, SYSTEMS } from './systems.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ResponseContext {
  readonly respondedAt: Date;
  /** The case id: the checkpoint's `thread_id` and `ClaimResponse.identifier`. */
  readonly caseId: string;
  /** Why a referral happened. Ignored for an approval. */
  readonly referralReason?: ReferralReason;
}

/**
 * The fields every `ClaimResponse` this surface writes shares, whatever its
 * outcome. `created` is when the response was made: the `$submit` exchange
 * for the agent's answer, the determination for a clinician's.
 */
function responseBase(
  claim: PasClaim,
  context: { readonly caseId: string; readonly createdAt: Date },
): PasClaimResponse {
  return {
    resourceType: 'ClaimResponse',
    id: `cr-${context.caseId}`,
    meta: { security: [{ ...HTEST }] },
    identifier: [{ system: SYSTEMS.CASE_ID, value: context.caseId }],
    status: 'active',
    type: claim.type,
    use: 'preauthorization',
    patient: claim.patient,
    created: context.createdAt.toISOString(),
    insurer: claim.insurer ?? { display: 'unknown insurer' },
    requestor: claim.provider,
    ...(claim.id === undefined ? {} : { request: { reference: `Claim/${claim.id}` } }),
    outcome: 'queued',
  };
}

/** The approval period: from the service date, for the policy's number of days. */
function approvalPeriod(claim: PasClaim, policy: Policy): { start: string; end: string } {
  const serviceDate = claim.item?.[0]?.servicedDate ?? claim.created;
  return {
    start: serviceDate.slice(0, 10),
    end: addDays(serviceDate, policy.approvalPeriodDays - 1),
  };
}

function titlesOf(policy: Policy, criterionIds: readonly string[]): string {
  return criterionIds
    .map((id) => policy.criteria.find((criterion) => criterion.id === id)?.title ?? id)
    .join('; ');
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The note a requester reads on a referral. Every string is a template or a
 * policy title; nothing the model wrote reaches it.
 */
function referralNote(
  claim: PasClaim,
  disposition: Extract<AgentDisposition, { kind: 'refer-to-clinician' }>,
  policy: Policy | undefined,
  reason: ReferralReason,
): string {
  const hcpcs = claim.item?.[0]?.productOrService.coding?.find(
    (coding) => coding.system === SYSTEMS.HCPCS,
  )?.code;

  if (reason === 'no-policy' || policy === undefined) {
    return `No policy for HCPCS ${hcpcs ?? 'code'} is held for automated review, so a clinician will review the request.`;
  }
  if (reason === 'coverage-inactive') {
    return 'The submitted coverage is not active on the date of service, so a clinician will review the request.';
  }

  const unconfirmed = disposition.findings
    .filter((finding) => finding.status !== 'met')
    .map((finding) => finding.criterionId);
  return (
    `A clinician will review this request against ${policy.title} (${policy.id} ${policy.version}).` +
    (unconfirmed.length === 0
      ? ''
      : ` Criteria not confirmed from the submitted record: ${titlesOf(policy, unconfirmed)}.`)
  );
}

/**
 * The only place FHIR meets the domain types (P3-A decided the determination
 * types are the domain model and FHIR is the wire format).
 *
 * `disposition` is parsed through `AgentDispositionSchema` before it is read.
 * That union has no `denial` or `partial-approval` member, so a forged adverse
 * value throws here, as it does at `RunResponse`'s egress.
 *
 * An approval is `outcome: complete` with a `preAuthRef` and a
 * `preAuthPeriod`; a referral is `outcome: queued` with neither. No branch
 * produces `error`, `partial` or denial wording. PAS marks a pend with the X12
 * review-action code `A4` under `complete`; ADR 0008 keeps X12 out, so this
 * surface uses base R4's `queued` and says it is shaped after PAS 2.2.1.
 *
 * `disposition` and `processNote` are built from fixed templates and the
 * policy's criterion titles. The model's per-criterion rationale stays in
 * graph state and the checkpoint, where a clinician reads it.
 */
export function toClaimResponse(
  claim: PasClaim,
  disposition: AgentDisposition,
  policy: Policy | undefined,
  context: ResponseContext,
): PasClaimResponse {
  const parsed = AgentDispositionSchema.parse(disposition);

  const base = responseBase(claim, { caseId: context.caseId, createdAt: context.respondedAt });

  if (parsed.kind === 'automated-approval') {
    if (policy === undefined) {
      throw new Error('an automated approval needs the policy it was made under');
    }
    return {
      ...base,
      outcome: 'complete',
      disposition: 'Approved by automated review: every criterion of the policy is met.',
      preAuthRef: context.caseId,
      preAuthPeriod: approvalPeriod(claim, policy),
      processNote: [
        {
          number: 1,
          type: 'display',
          text:
            `Approved under ${policy.title} (${policy.id} ${policy.version}). ` +
            `Criteria met: ${titlesOf(policy, parsed.criteriaMet)}.`,
        },
      ],
    };
  }

  return {
    ...base,
    outcome: 'queued',
    disposition: 'Pended for clinician review. No decision has been made.',
    processNote: [
      {
        number: 1,
        type: 'display',
        text: referralNote(claim, parsed, policy, context.referralReason ?? 'criteria'),
      },
    ],
  };
}

/**
 * What a clinician may decide on a pended case through the review route. A
 * `partial-approval` is adverse and P3-A types it, but it carries no
 * statement of what was approved, so a response built from it could not say
 * what the provider may deliver. It is refused here, and the route answers
 * 422 before it gets this far.
 */
const ClinicianDeterminationSchema = z.discriminatedUnion('kind', [
  ClinicianApprovalSchema,
  AdverseDeterminationRecordSchema.extend({ kind: z.literal('denial') }),
]);

/**
 * The `ClaimResponse` for a clinician's determination on a pended case (P3-E).
 *
 * Both branches are `outcome: complete`: the request has been decided. An
 * approval carries a `preAuthRef` and, when a policy covers the service, a
 * `preAuthPeriod`. A denial carries neither, and its `processNote` is the
 * clinician's `specificReason`, which CMS-0057-F requires for every denied
 * prior authorization (42 CFR 422.122(a)). `disposition` is a fixed template.
 * No branch carries model text: the findings and their rationale stay on the
 * case, where the reviewer read them.
 *
 * The determination is parsed before it is read, so a value that is not a
 * clinician approval or a denial throws, a cast one included.
 */
export function toDeterminationResponse(
  claim: PasClaim,
  determination: ClinicianApproval | AdverseDetermination,
  policy: Policy | undefined,
  context: { readonly decidedAt: Date; readonly caseId: string },
): PasClaimResponse {
  const parsed = ClinicianDeterminationSchema.parse(determination);
  const base = responseBase(claim, { caseId: context.caseId, createdAt: context.decidedAt });

  if (parsed.kind === 'clinician-approval') {
    return {
      ...base,
      outcome: 'complete',
      disposition: 'Approved after clinician review.',
      preAuthRef: context.caseId,
      ...(policy === undefined ? {} : { preAuthPeriod: approvalPeriod(claim, policy) }),
      processNote: [
        {
          number: 1,
          type: 'display',
          text:
            policy === undefined
              ? 'Approved by a clinician.'
              : `Approved by a clinician under ${policy.title} (${policy.id} ${policy.version}).`,
        },
      ],
    };
  }

  return {
    ...base,
    outcome: 'complete',
    disposition: 'Denied after clinician review. The reason is stated in the note.',
    processNote: [{ number: 1, type: 'display', text: parsed.specificReason }],
  };
}

/**
 * The `ClaimResponse` for a reversal on reconsideration (P3-F): the approval
 * that becomes the case's response in force, so `$inquire` returns it with no
 * change to the inquiry path.
 *
 * It is the clinician approval's shape, `outcome: complete` with a
 * `preAuthRef` and, under a policy, a `preAuthPeriod`, with a fixed
 * `disposition` saying it was approved on reconsideration. The physician's
 * explanation stays on the appeal, as the agent's rationale stays on the
 * case: no free text reaches this response. An affirmation has no response
 * of its own, because the denial stays in force until the independent entity
 * rules, so anything but a reversal throws, a cast one included.
 */
export function toReconsideredResponse(
  claim: PasClaim,
  reconsideration: Reconsideration,
  policy: Policy | undefined,
  context: { readonly decidedAt: Date; readonly caseId: string },
): PasClaimResponse {
  const parsed = ReconsiderationRecordSchema.parse(reconsideration);
  if (parsed.kind !== 'reversal') {
    throw new Error('only a reversal issues a response; an affirmation leaves the denial in force');
  }
  return {
    ...responseBase(claim, { caseId: context.caseId, createdAt: context.decidedAt }),
    outcome: 'complete',
    disposition: 'Approved on reconsideration.',
    preAuthRef: context.caseId,
    ...(policy === undefined ? {} : { preAuthPeriod: approvalPeriod(claim, policy) }),
    processNote: [
      {
        number: 1,
        type: 'display',
        text:
          policy === undefined
            ? 'The denial was reversed on reconsideration by a physician who did not make it.'
            : `The denial was reversed on reconsideration under ${policy.title} ` +
              `(${policy.id} ${policy.version}) by a physician who did not make it.`,
      },
    ],
  };
}

/**
 * The `$submit` response: a `collection` bundle whose first entry is the
 * `ClaimResponse` (PAS's `ClaimResponseFirst`), followed by the resources it
 * references that the request carried, so the response stands on its own.
 */
export function toResponseBundle(
  request: FhirBundle,
  claimResponse: PasClaimResponse,
  context: Pick<ResponseContext, 'caseId' | 'respondedAt'>,
): FhirBundle {
  const referenced = [claimResponse.patient, claimResponse.insurer, claimResponse.requestor]
    .map((reference) => reference?.reference)
    .filter((reference): reference is string => reference !== undefined);

  const entries = [...new Set(referenced)].flatMap((reference) => {
    const resource = resolveReference(request, reference);
    if (resource === undefined) return [];
    const fullUrl = request.entry?.find((entry) => entry.resource === resource)?.fullUrl;
    return [{ ...(fullUrl === undefined ? {} : { fullUrl }), resource }];
  });

  return {
    resourceType: 'Bundle',
    id: `response-${context.caseId}`,
    meta: { security: [{ ...HTEST }] },
    identifier: { system: SYSTEMS.CASE_ID, value: context.caseId },
    type: 'collection',
    timestamp: context.respondedAt.toISOString(),
    entry: [
      {
        fullUrl: `https://example.org/fhir/ClaimResponse/${claimResponse.id ?? context.caseId}`,
        resource: claimResponse,
      },
      ...entries,
    ],
  };
}
