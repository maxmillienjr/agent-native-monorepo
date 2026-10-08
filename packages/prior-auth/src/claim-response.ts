import { AgentDispositionSchema, type AgentDisposition } from '@repo/determination';
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

  const base: PasClaimResponse = {
    resourceType: 'ClaimResponse',
    id: `cr-${context.caseId}`,
    meta: { security: [{ ...HTEST }] },
    identifier: [{ system: SYSTEMS.CASE_ID, value: context.caseId }],
    status: 'active',
    type: claim.type,
    use: 'preauthorization',
    patient: claim.patient,
    created: context.respondedAt.toISOString(),
    insurer: claim.insurer ?? { display: 'unknown insurer' },
    requestor: claim.provider,
    ...(claim.id === undefined ? {} : { request: { reference: `Claim/${claim.id}` } }),
    outcome: 'queued',
  };

  if (parsed.kind === 'automated-approval') {
    if (policy === undefined) {
      throw new Error('an automated approval needs the policy it was made under');
    }
    const serviceDate = claim.item?.[0]?.servicedDate ?? claim.created;
    return {
      ...base,
      outcome: 'complete',
      disposition: 'Approved by automated review: every criterion of the policy is met.',
      preAuthRef: context.caseId,
      preAuthPeriod: {
        start: serviceDate.slice(0, 10),
        end: addDays(serviceDate, policy.approvalPeriodDays - 1),
      },
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
