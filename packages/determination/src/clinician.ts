/**
 * The clinician entry point, reachable only as `@repo/determination/clinician`.
 *
 * It is deliberately absent from `src/index.ts`. The agent imports the barrel,
 * and ESLint forbids this subpath under `apps/agent-service/src/agent/**`, so
 * the graph can approve or refer but has no way to construct a denial.
 */
import {
  AdverseDeterminationRecordSchema,
  type AdverseDetermination,
  type ClinicianAttestation,
} from './determination.js';

/**
 * The one constructor for an adverse determination, and the one place in the
 * repository that asserts its brand.
 *
 * Both arguments are parsed, because the types are erased and a caller on the
 * far side of an HTTP boundary is holding JSON: an empty `specificReason` or an
 * `attestedAt` with no offset throws here rather than being recorded.
 */
export function attestAdverseDetermination(
  input: { kind: 'denial' | 'partial-approval'; specificReason: string },
  attestation: ClinicianAttestation,
): AdverseDetermination {
  const record = AdverseDeterminationRecordSchema.parse({ ...input, attestation });
  return record as AdverseDetermination;
}
