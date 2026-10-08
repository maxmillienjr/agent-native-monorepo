import type { z } from 'zod';
import { priorityFromCode, type Priority } from './clock.js';
import type { Payer } from './policy.js';
import {
  BundleSchema,
  ClaimSchema,
  ConditionSchema,
  CoverageSchema,
  DocumentReferenceSchema,
  OrganizationSchema,
  type FhirBundle,
  type FhirCondition,
  type FhirCoverage,
  type FhirDocumentReference,
  type FhirOrganization,
  type PasClaim,
} from './fhir/resources.js';
import { SYSTEMS } from './systems.js';

/**
 * A `$submit` request bundle, read far enough to route it.
 *
 * Everything here is derived from the bundle by code. The agent reads the
 * evidence; it never reads the routing.
 */
export interface PriorAuthRequest {
  readonly bundle: FhirBundle;
  readonly claim: PasClaim;
  /** `Claim/<id>`. */
  readonly claimReference: string;
  readonly hcpcs: string;
  /** `Claim.item[0].servicedDate`, or `Claim.created`'s date when the item has none. */
  readonly serviceDate: string;
  readonly priority: Priority;
  readonly diagnoses: readonly { readonly code: string; readonly display?: string }[];
  readonly coverage: FhirCoverage;
  readonly insurer: FhirOrganization;
  /** Every `ResourceType/id` in the bundle: what a citation may resolve to. */
  readonly resourceIds: readonly string[];
}

export interface SubmissionIssue {
  readonly code: 'structure' | 'required' | 'value' | 'not-supported';
  readonly diagnostics: string;
  readonly expression?: string;
}

/**
 * The three ends of reading a submission. `invalid` is a body this operation
 * cannot read (400); `unprocessable` is a readable `Claim` the surface cannot
 * act on (422).
 */
export type Submission =
  | { readonly kind: 'ok'; readonly request: PriorAuthRequest }
  | { readonly kind: 'invalid'; readonly issues: readonly SubmissionIssue[] }
  | { readonly kind: 'unprocessable'; readonly issues: readonly SubmissionIssue[] };

type Entry = NonNullable<FhirBundle['entry']>[number];

function referenceOf(resource: { resourceType: string; id?: string | undefined }): string {
  return `${resource.resourceType}/${resource.id ?? ''}`;
}

/** The entry a `Type/id` reference, or the entry's full URL, names. */
export function resolveReference(
  bundle: FhirBundle,
  reference: string | undefined,
): Entry['resource'] {
  if (reference === undefined) return undefined;
  for (const entry of bundle.entry ?? []) {
    const resource = entry.resource;
    if (resource === undefined) continue;
    if (entry.fullUrl === reference) return resource;
    if (resource.id !== undefined && referenceOf(resource) === reference) return resource;
  }
  return undefined;
}

function resolveAs<S extends z.ZodTypeAny>(
  schema: S,
  bundle: FhirBundle,
  reference: string | undefined,
): z.infer<S> | undefined {
  const parsed = schema.safeParse(resolveReference(bundle, reference));
  return parsed.success ? (parsed.data as z.infer<S>) : undefined;
}

function issuesFrom(error: z.ZodError, prefix: string): SubmissionIssue[] {
  return error.issues.map((issue) => ({
    code: 'structure',
    diagnostics: issue.message,
    expression: [prefix, ...issue.path.map(String)].join('.'),
  }));
}

/**
 * Reads a `$submit` body, or says why it cannot.
 *
 * PAS's invariant `ClaimFirst` puts the `Claim` first in the request bundle,
 * and this surface takes the first entry as the claim rather than searching
 * for one, so a bundle that breaks the invariant is answered as malformed.
 */
export function readSubmission(body: unknown, payer: Payer): Submission {
  const bundle = BundleSchema.safeParse(body);
  if (!bundle.success) {
    return { kind: 'invalid', issues: issuesFrom(bundle.error, 'Bundle') };
  }

  const first = bundle.data.entry?.[0]?.resource;
  if (first?.resourceType !== 'Claim') {
    return {
      kind: 'invalid',
      issues: [
        {
          code: 'structure',
          diagnostics: 'the first entry of a $submit bundle must be a Claim',
          expression: 'Bundle.entry[0].resource',
        },
      ],
    };
  }

  const claim = ClaimSchema.safeParse(first);
  if (!claim.success) {
    return { kind: 'invalid', issues: issuesFrom(claim.error, 'Claim') };
  }

  return readClaim(bundle.data, claim.data, payer);
}

function readClaim(bundle: FhirBundle, claim: PasClaim, payer: Payer): Submission {
  const issues: SubmissionIssue[] = [];
  const unprocessable = (issue: SubmissionIssue): void => {
    issues.push(issue);
  };

  if (claim.use !== 'preauthorization') {
    unprocessable({
      code: 'not-supported',
      diagnostics: `Claim.use is ${claim.use}; this operation accepts preauthorization only`,
      expression: 'Claim.use',
    });
  }

  const item = claim.item?.[0];
  const hcpcs = item?.productOrService.coding?.find(
    (coding) => coding.system === SYSTEMS.HCPCS,
  )?.code;
  if (item === undefined) {
    unprocessable({
      code: 'required',
      diagnostics: 'the Claim has no item',
      expression: 'Claim.item',
    });
  } else if (hcpcs === undefined) {
    unprocessable({
      code: 'value',
      diagnostics: 'Claim.item[0].productOrService carries no HCPCS Level II coding',
      expression: 'Claim.item[0].productOrService',
    });
  }

  const insurer = resolveAs(OrganizationSchema, bundle, claim.insurer?.reference);
  const knownInsurer = insurer?.identifier?.some(
    (identifier) =>
      identifier.system === payer.payer.identifier.system &&
      identifier.value === payer.payer.identifier.value,
  );
  if (insurer === undefined || knownInsurer !== true) {
    unprocessable({
      code: 'not-supported',
      diagnostics: `Claim.insurer is not ${payer.payer.name}, the only payer this surface serves`,
      expression: 'Claim.insurer',
    });
  }

  const focal = claim.insurance.find((insurance) => insurance.focal) ?? claim.insurance[0];
  const coverage = resolveAs(CoverageSchema, bundle, focal?.coverage.reference);
  if (coverage === undefined) {
    unprocessable({
      code: 'required',
      diagnostics:
        'the focal Claim.insurance.coverage does not resolve to a Coverage in the bundle',
      expression: 'Claim.insurance.coverage',
    });
  }

  if (
    issues.length > 0 ||
    item === undefined ||
    hcpcs === undefined ||
    insurer === undefined ||
    coverage === undefined
  ) {
    return { kind: 'unprocessable', issues };
  }

  const diagnoses = (claim.diagnosis ?? []).flatMap((diagnosis) =>
    (diagnosis.diagnosisCodeableConcept?.coding ?? [])
      .filter((coding) => coding.system === SYSTEMS.ICD10CM && coding.code !== undefined)
      .map((coding) => ({
        code: coding.code as string,
        ...(coding.display === undefined ? {} : { display: coding.display }),
      })),
  );

  return {
    kind: 'ok',
    request: {
      bundle,
      claim,
      claimReference: referenceOf(claim),
      hcpcs,
      serviceDate: item.servicedDate ?? claim.created.slice(0, 10),
      priority: priorityFromCode(
        claim.priority.coding?.find((coding) => coding.system === SYSTEMS.PROCESS_PRIORITY)?.code,
      ),
      diagnoses,
      coverage,
      insurer,
      resourceIds: (bundle.entry ?? []).flatMap((entry) =>
        entry.resource?.id === undefined ? [] : [referenceOf(entry.resource)],
      ),
    },
  };
}

/**
 * Whether the coverage was in force on the date of service.
 *
 * Dates compare as strings because FHIR `date` and the date part of a
 * `dateTime` sort lexically. An open-ended period is in force from its start.
 */
export function coverageActiveOn(coverage: FhirCoverage, date: string): boolean {
  if (coverage.status !== 'active') return false;
  const day = date.slice(0, 10);
  const start = coverage.period?.start?.slice(0, 10);
  const end = coverage.period?.end?.slice(0, 10);
  if (start !== undefined && day < start) return false;
  if (end !== undefined && day > end) return false;
  return true;
}

/** One piece of the member's record, as the model is shown it. */
export interface EvidenceItem {
  /** `ResourceType/id`, which is what a finding cites. */
  readonly reference: string;
  readonly text: string;
}

function conditionText(condition: FhirCondition): string {
  const coded = (condition.code?.coding ?? [])
    .map((coding) => [coding.code, coding.display].filter(Boolean).join(' '))
    .join('; ');
  const onset = condition.onsetDateTime === undefined ? '' : ` Onset ${condition.onsetDateTime}.`;
  const recorded =
    condition.recordedDate === undefined ? '' : ` Recorded ${condition.recordedDate}.`;
  return `Condition: ${coded || condition.code?.text || 'uncoded'}.${onset}${recorded}`;
}

function documentText(document: FhirDocumentReference): string {
  const notes = document.content
    .map((content) => content.attachment)
    .filter((attachment) => (attachment.contentType ?? '').startsWith('text/plain'))
    .map((attachment) => Buffer.from(attachment.data ?? '', 'base64').toString('utf8'));
  const header = [
    document.description,
    document.date === undefined ? undefined : `dated ${document.date}`,
  ]
    .filter(Boolean)
    .join(', ');
  return `Clinical note${header === '' ? '' : ` (${header})`}:\n${notes.join('\n')}`;
}

/**
 * The evidence the model reads: every `Condition` and every plain-text
 * `DocumentReference` in the bundle, in bundle order, each labelled with the
 * reference a finding has to cite.
 *
 * In bundle order because the cassette is keyed on the request, and a
 * reordering would change the hash of a request that says the same thing.
 */
export function evidenceFor(request: PriorAuthRequest): EvidenceItem[] {
  const evidence: EvidenceItem[] = [];
  for (const entry of request.bundle.entry ?? []) {
    const resource = entry.resource;
    if (resource?.id === undefined) continue;
    if (resource.resourceType === 'Condition') {
      const condition = ConditionSchema.safeParse(resource);
      if (condition.success) {
        evidence.push({ reference: referenceOf(resource), text: conditionText(condition.data) });
      }
    } else if (resource.resourceType === 'DocumentReference') {
      const document = DocumentReferenceSchema.safeParse(resource);
      if (document.success) {
        evidence.push({ reference: referenceOf(resource), text: documentText(document.data) });
      }
    }
  }
  return evidence;
}
