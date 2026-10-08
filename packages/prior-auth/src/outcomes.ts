import type { FhirCapabilityStatement, FhirOperationOutcome } from './fhir/resources.js';
import type { SubmissionIssue } from './request.js';
import { HTEST } from './systems.js';

/** An `OperationOutcome` with one `error` issue per problem, for a 4xx or 5xx answer. */
export function operationOutcome(
  issues: readonly (Omit<SubmissionIssue, 'code'> & {
    readonly code: FhirOperationOutcome['issue'][number]['code'];
  })[],
): FhirOperationOutcome {
  return {
    resourceType: 'OperationOutcome',
    meta: { security: [{ ...HTEST }] },
    issue: issues.map((issue) => ({
      severity: 'error',
      code: issue.code,
      diagnostics: issue.diagnostics,
      ...(issue.expression === undefined ? {} : { expression: [issue.expression] }),
    })),
  };
}

/** The canonical of base R4's `Claim/$submit` operation. */
export const CLAIM_SUBMIT_DEFINITION = 'http://hl7.org/fhir/OperationDefinition/Claim-submit';

/**
 * What `GET /fhir/metadata` returns: exactly the operations the service
 * implements.
 *
 * It describes itself as shaped after PAS 2.2.1 and does not `instantiate`
 * PAS's CapabilityStatement, because it is not conformant: a conformant PAS
 * `Claim` needs X12 codes ADR 0008 keeps out of the repository, and a PAS
 * server must support subscriptions and `$inquire`, which are P3-E's.
 */
export function capabilityStatement(date: string): FhirCapabilityStatement {
  return {
    resourceType: 'CapabilityStatement',
    meta: { security: [{ ...HTEST }] },
    name: 'QuillmarkPriorAuthorizationIntake',
    title: 'Quillmark Health Partners prior-authorization intake',
    status: 'active',
    experimental: true,
    date,
    publisher: 'agent-native-monorepo (synthetic)',
    description:
      'A FHIR R4 prior-authorization intake shaped after Da Vinci PAS 2.2.1, not conformant ' +
      'to it: no X12 code values, no subscriptions and no $inquire. Synthetic data only.',
    kind: 'instance',
    software: { name: 'agent-service' },
    implementation: { description: 'agent-service prior-authorization intake' },
    fhirVersion: '4.0.1',
    format: ['application/fhir+json', 'application/json'],
    rest: [
      {
        mode: 'server',
        resource: [
          {
            type: 'Claim',
            operation: [{ name: 'submit', definition: CLAIM_SUBMIT_DEFINITION }],
          },
        ],
      },
    ],
  };
}
