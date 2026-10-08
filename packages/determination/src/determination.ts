import { z } from 'zod';

/**
 * The brand on an adverse determination.
 *
 * Declared and never exported, so no other module can name it, and an object
 * literal written anywhere else cannot satisfy `AdverseDetermination`. The one
 * place that asserts it is `attestAdverseDetermination` in `./clinician`.
 *
 * It is a type and nothing else: there is no symbol at runtime, which is why
 * the brand stops accidents and not adversaries. A value forged with
 * `as unknown as AdverseDetermination` still compiles; what stops it leaving
 * the process is a strict parse at the boundary, never this declaration.
 */
declare const adverse: unique symbol;

export const ClinicianAttestationSchema = z
  .object({
    reviewerId: z.string().min(1),
    credential: z.object({ type: z.string().min(1), jurisdiction: z.string().min(1) }).strict(),
    attestedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ClinicianAttestation = z.infer<typeof ClinicianAttestationSchema>;

/**
 * The agent's reading of one criterion. The shape is the one P3-D proposed for
 * its `assess` node, which reads each criterion and cites the resources in the
 * request that evidence it.
 */
export const CriterionFindingSchema = z
  .object({
    criterionId: z.string().min(1),
    status: z.enum(['met', 'not-met', 'insufficient']),
    /** `ResourceType/id` references into the request's bundle. */
    evidence: z.array(z.string().min(1)).readonly(),
    /** Model text. It is for the reviewer and is never a user-visible reason. */
    rationale: z.string(),
  })
  .strict();
export type CriterionFinding = Readonly<z.infer<typeof CriterionFindingSchema>>;

/**
 * Final and favourable. It approves the request as submitted — there is no
 * quantity, duration or scope field, so approving less than was asked is a
 * `partial-approval`, which is adverse and needs a clinician.
 */
export const AutomatedApprovalSchema = z
  .object({
    kind: z.literal('automated-approval'),
    criteriaMet: z.array(z.string().min(1)).min(1).readonly(),
  })
  .strict();
export type AutomatedApproval = Readonly<z.infer<typeof AutomatedApprovalSchema>>;

/**
 * Not a decision. The agent's reading of the criteria, handed to a person.
 *
 * It carries a finding per criterion and no suggested outcome on purpose: a
 * referral labelled "recommend deny" asks the reviewer to confirm the tool's
 * outcome, which is close to what the CMS FAQ rules out — an algorithm alone
 * as the basis to deny.
 */
export const ClinicianReferralSchema = z
  .object({
    kind: z.literal('refer-to-clinician'),
    findings: z.array(CriterionFindingSchema).readonly(),
  })
  .strict();
export type ClinicianReferral = Readonly<z.infer<typeof ClinicianReferralSchema>>;

/**
 * Everything the agent may produce. `denial` and `partial-approval` are not
 * members, so parsing an adverse value through this schema throws.
 */
export const AgentDispositionSchema = z.discriminatedUnion('kind', [
  AutomatedApprovalSchema,
  ClinicianReferralSchema,
]);
export type AgentDisposition = AutomatedApproval | ClinicianReferral;

/**
 * A person approved. It carries the attestation so the record says who, and no
 * brand, because nothing requires an approval to be gated.
 */
export const ClinicianApprovalSchema = z
  .object({
    kind: z.literal('clinician-approval'),
    attestation: ClinicianAttestationSchema,
  })
  .strict();
export type ClinicianApproval = Readonly<z.infer<typeof ClinicianApprovalSchema>>;

/**
 * The shape of an adverse determination, unbranded. Parsing through it checks a
 * stored record without minting one.
 *
 * Every adverse outcome needs the attestation whatever its basis: a gate that
 * has to be told a denial is on medical necessity before it applies can be
 * routed around by mislabelling the basis.
 */
export const AdverseDeterminationRecordSchema = z
  .object({
    kind: z.enum(['denial', 'partial-approval']),
    /** CMS-0057-F requires a specific reason for every denied prior authorization. */
    specificReason: z.string().trim().min(1),
    attestation: ClinicianAttestationSchema,
  })
  .strict();
export type AdverseDeterminationRecord = Readonly<z.infer<typeof AdverseDeterminationRecordSchema>>;

export interface AdverseDetermination extends AdverseDeterminationRecord {
  readonly [adverse]: true;
}

/**
 * Validates any determination, as a reader such as P3-C's ledger needs to. It
 * returns an unbranded record: a `.brand()` schema here would be a second
 * constructor for `AdverseDetermination`, since its `parse` mints one from any
 * input of the right shape.
 */
export const DeterminationRecordSchema = z.discriminatedUnion('kind', [
  AutomatedApprovalSchema,
  ClinicianApprovalSchema,
  AdverseDeterminationRecordSchema,
]);
export type DeterminationRecord = z.infer<typeof DeterminationRecordSchema>;

export type Determination = AutomatedApproval | ClinicianApproval | AdverseDetermination;

/**
 * The brand on a reconsidered determination (P3-F). Declared and never
 * exported, as `adverse` is, so the one place that asserts it is
 * `attestReconsideration` in `./clinician`.
 */
declare const reconsidered: unique symbol;

/**
 * A reconsideration of an adverse determination, unbranded (P3-F, 42 CFR
 * § 422.590). Parsing through it checks a stored record without minting one.
 *
 * A reconsideration either reverses the denial or affirms it. There is no
 * third kind: a dismissal is not a reconsidered determination, and is not
 * typed here.
 *
 * The refinement is § 422.590(h)(1), "A person or persons who were not
 * involved in making the organization determination must conduct the
 * reconsideration", reduced to what the record can show: the reviewer who
 * attests is not the reviewer who attested the determination under
 * reconsideration. A stored record edited to break that fails its read.
 */
export const ReconsiderationRecordSchema = z
  .object({
    kind: z.enum(['reversal', 'affirmation']),
    /** The written explanation § 422.590(a)(2) requires, and the reason a reversal gives. */
    explanation: z.string().trim().min(1),
    /**
     * Whether the reconsidering physician found good cause for a request filed
     * after the 60-day window (§ 422.582(c)). It is part of what was signed.
     */
    goodCauseFound: z.boolean(),
    attestation: ClinicianAttestationSchema,
    /** Who attested the determination under reconsideration. */
    initialReviewerId: z.string().min(1),
  })
  .strict()
  .refine((record) => record.attestation.reviewerId !== record.initialReviewerId, {
    message: 'a reconsideration is made by someone not involved in the determination',
    path: ['attestation', 'reviewerId'],
  });
export type ReconsiderationRecord = Readonly<z.infer<typeof ReconsiderationRecordSchema>>;

export interface Reconsideration extends ReconsiderationRecord {
  readonly [reconsidered]: true;
}
