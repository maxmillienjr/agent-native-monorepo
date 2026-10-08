/**
 * The clinician entry point, reachable only as `@repo/determination/clinician`.
 *
 * It is deliberately absent from `src/index.ts`. The agent imports the barrel,
 * and ESLint forbids this subpath under `apps/agent-service/src/agent/**`, so
 * the graph can approve or refer but has no way to construct a denial, or a
 * reconsideration of one.
 */
import {
  AdverseDeterminationRecordSchema,
  ReconsiderationRecordSchema,
  type AdverseDetermination,
  type AdverseDeterminationRecord,
  type ClinicianAttestation,
  type Reconsideration,
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

/**
 * The reconsidering reviewer is the reviewer who made the determination under
 * reconsideration, which 42 CFR § 422.590(h)(1) forbids.
 */
export class InvolvedReviewerError extends Error {
  override readonly name = 'InvolvedReviewerError';

  constructor(readonly reviewerId: string) {
    super(
      `${reviewerId} made the determination under reconsideration, and a reconsideration ` +
        'is made by someone not involved in it (42 CFR § 422.590(h)(1)).',
    );
  }
}

/**
 * The one constructor for a reconsidered determination (P3-F), and the one
 * place in the repository that asserts its brand.
 *
 * It takes the stored adverse determination itself, not a reviewer id, so a
 * caller cannot pass the wrong reviewer by accident: the reviewer excluded is
 * the one whose attestation the denial carries. Every argument is parsed, as
 * `attestAdverseDetermination`'s are, and an attesting reviewer who is the
 * initial one throws `InvolvedReviewerError` before anything is built.
 *
 * Who may reconsider beyond that, a physician under § 422.590(h)(2), is the
 * caller's check against the policy, as the credential check on a denial is.
 */
export function attestReconsideration(
  initial: AdverseDeterminationRecord,
  input: { kind: 'reversal' | 'affirmation'; explanation: string; goodCauseFound: boolean },
  attestation: ClinicianAttestation,
): Reconsideration {
  const denial = AdverseDeterminationRecordSchema.parse(initial);
  if (attestation.reviewerId === denial.attestation.reviewerId) {
    throw new InvolvedReviewerError(attestation.reviewerId);
  }
  const record = ReconsiderationRecordSchema.parse({
    ...input,
    attestation,
    initialReviewerId: denial.attestation.reviewerId,
  });
  return record as Reconsideration;
}
