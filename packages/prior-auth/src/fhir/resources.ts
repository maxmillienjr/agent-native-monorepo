import { z } from 'zod';
import type {
  Bundle,
  CapabilityStatement,
  Claim,
  ClaimCareTeam,
  ClaimDiagnosis,
  ClaimInsurance,
  ClaimItem,
  ClaimResponse,
  ClaimSupportingInfo,
  Condition,
  Coverage,
  DocumentReference,
  FhirResource,
  OperationOutcome,
  Organization,
  Parameters,
  Patient,
  Practitioner,
} from 'fhir/r4.js';
import {
  AddressSchema,
  AttachmentSchema,
  CodeableConceptSchema,
  ContactPointSchema,
  HumanNameSchema,
  IdentifierSchema,
  MetaSchema,
  PeriodSchema,
  QuantitySchema,
  ReferenceSchema,
} from './datatypes.js';

/**
 * The R4 resources the surface reads and writes, as a subset that passes
 * unknown elements through. See `datatypes.ts` for why each one is annotated with
 * its `@types/fhir` interface.
 */

const resourceBase = {
  id: z.string().optional(),
  meta: MetaSchema.optional(),
};

export const PatientSchema: z.ZodType<Patient> = z
  .object({
    resourceType: z.literal('Patient'),
    ...resourceBase,
    identifier: z.array(IdentifierSchema).optional(),
    active: z.boolean().optional(),
    name: z.array(HumanNameSchema).optional(),
    telecom: z.array(ContactPointSchema).optional(),
    gender: z.enum(['male', 'female', 'other', 'unknown']).optional(),
    birthDate: z.string().optional(),
    address: z.array(AddressSchema).optional(),
  })
  .passthrough();

export const CoverageSchema: z.ZodType<Coverage> = z
  .object({
    resourceType: z.literal('Coverage'),
    ...resourceBase,
    identifier: z.array(IdentifierSchema).optional(),
    status: z.enum(['active', 'cancelled', 'draft', 'entered-in-error']),
    subscriberId: z.string().optional(),
    beneficiary: ReferenceSchema,
    relationship: CodeableConceptSchema.optional(),
    period: PeriodSchema.optional(),
    payor: z.array(ReferenceSchema).min(1),
    class: z
      .array(
        z
          .object({
            type: CodeableConceptSchema,
            value: z.string(),
            name: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const PractitionerSchema: z.ZodType<Practitioner> = z
  .object({
    resourceType: z.literal('Practitioner'),
    ...resourceBase,
    identifier: z.array(IdentifierSchema).optional(),
    active: z.boolean().optional(),
    name: z.array(HumanNameSchema).optional(),
    telecom: z.array(ContactPointSchema).optional(),
  })
  .passthrough();

export const OrganizationSchema: z.ZodType<Organization> = z
  .object({
    resourceType: z.literal('Organization'),
    ...resourceBase,
    identifier: z.array(IdentifierSchema).optional(),
    active: z.boolean().optional(),
    type: z.array(CodeableConceptSchema).optional(),
    name: z.string().optional(),
    telecom: z.array(ContactPointSchema).optional(),
    address: z.array(AddressSchema).optional(),
  })
  .passthrough();

export const ConditionSchema: z.ZodType<Condition> = z
  .object({
    resourceType: z.literal('Condition'),
    ...resourceBase,
    clinicalStatus: CodeableConceptSchema.optional(),
    verificationStatus: CodeableConceptSchema.optional(),
    category: z.array(CodeableConceptSchema).optional(),
    code: CodeableConceptSchema.optional(),
    subject: ReferenceSchema,
    onsetDateTime: z.string().optional(),
    recordedDate: z.string().optional(),
  })
  .passthrough();

export const DocumentReferenceSchema: z.ZodType<DocumentReference> = z
  .object({
    resourceType: z.literal('DocumentReference'),
    ...resourceBase,
    status: z.enum(['current', 'superseded', 'entered-in-error']),
    type: CodeableConceptSchema.optional(),
    category: z.array(CodeableConceptSchema).optional(),
    subject: ReferenceSchema.optional(),
    date: z.string().optional(),
    author: z.array(ReferenceSchema).optional(),
    description: z.string().optional(),
    content: z.array(z.object({ attachment: AttachmentSchema }).passthrough()).min(1),
  })
  .passthrough();

export const ClaimCareTeamSchema: z.ZodType<ClaimCareTeam> = z
  .object({
    sequence: z.number().int().positive(),
    provider: ReferenceSchema,
  })
  .passthrough();

export const ClaimSupportingInfoSchema: z.ZodType<ClaimSupportingInfo> = z
  .object({
    sequence: z.number().int().positive(),
    category: CodeableConceptSchema,
    timingDate: z.string().optional(),
    valueReference: ReferenceSchema.optional(),
  })
  .passthrough();

export const ClaimDiagnosisSchema: z.ZodType<ClaimDiagnosis> = z
  .object({
    sequence: z.number().int().positive(),
    diagnosisCodeableConcept: CodeableConceptSchema.optional(),
    diagnosisReference: ReferenceSchema.optional(),
  })
  .passthrough();

export const ClaimInsuranceSchema: z.ZodType<ClaimInsurance> = z
  .object({
    sequence: z.number().int().positive(),
    focal: z.boolean(),
    coverage: ReferenceSchema,
  })
  .passthrough();

export const ClaimItemSchema: z.ZodType<ClaimItem> = z
  .object({
    sequence: z.number().int().positive(),
    productOrService: CodeableConceptSchema,
    servicedDate: z.string().optional(),
    quantity: QuantitySchema.optional(),
    locationCodeableConcept: CodeableConceptSchema.optional(),
  })
  .passthrough();

export const ClaimSchema: z.ZodType<Claim> = z
  .object({
    resourceType: z.literal('Claim'),
    ...resourceBase,
    identifier: z.array(IdentifierSchema).optional(),
    status: z.enum(['active', 'cancelled', 'draft', 'entered-in-error']),
    type: CodeableConceptSchema,
    use: z.enum(['claim', 'preauthorization', 'predetermination']),
    patient: ReferenceSchema,
    created: z.string(),
    insurer: ReferenceSchema.optional(),
    provider: ReferenceSchema,
    priority: CodeableConceptSchema,
    careTeam: z.array(ClaimCareTeamSchema).optional(),
    supportingInfo: z.array(ClaimSupportingInfoSchema).optional(),
    diagnosis: z.array(ClaimDiagnosisSchema).optional(),
    insurance: z.array(ClaimInsuranceSchema).min(1),
    item: z.array(ClaimItemSchema).optional(),
  })
  .passthrough();

export const ClaimResponseSchema: z.ZodType<ClaimResponse> = z
  .object({
    resourceType: z.literal('ClaimResponse'),
    ...resourceBase,
    identifier: z.array(IdentifierSchema).optional(),
    status: z.enum(['active', 'cancelled', 'draft', 'entered-in-error']),
    type: CodeableConceptSchema,
    use: z.enum(['claim', 'preauthorization', 'predetermination']),
    patient: ReferenceSchema,
    created: z.string(),
    insurer: ReferenceSchema,
    requestor: ReferenceSchema.optional(),
    request: ReferenceSchema.optional(),
    outcome: z.enum(['queued', 'complete', 'error', 'partial']),
    disposition: z.string().optional(),
    preAuthRef: z.string().optional(),
    preAuthPeriod: PeriodSchema.optional(),
    processNote: z
      .array(
        z
          .object({
            number: z.number().int().positive().optional(),
            type: z.enum(['display', 'print', 'printoper']).optional(),
            text: z.string(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const OperationOutcomeSchema: z.ZodType<OperationOutcome> = z
  .object({
    resourceType: z.literal('OperationOutcome'),
    ...resourceBase,
    issue: z
      .array(
        z
          .object({
            severity: z.enum(['fatal', 'error', 'warning', 'information']),
            code: z.enum([
              'invalid',
              'structure',
              'required',
              'value',
              'processing',
              'not-supported',
              'exception',
            ]),
            diagnostics: z.string().optional(),
            expression: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export const CapabilityStatementSchema: z.ZodType<CapabilityStatement> = z
  .object({
    resourceType: z.literal('CapabilityStatement'),
    ...resourceBase,
    url: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    status: z.enum(['draft', 'active', 'retired', 'unknown']),
    experimental: z.boolean().optional(),
    date: z.string(),
    publisher: z.string().optional(),
    description: z.string().optional(),
    kind: z.enum(['instance', 'capability', 'requirements']),
    software: z.object({ name: z.string(), version: z.string().optional() }).passthrough(),
    implementation: z
      .object({ description: z.string(), url: z.string().optional() })
      .passthrough()
      .optional(),
    fhirVersion: z.literal('4.0.1'),
    format: z.array(z.string()).min(1),
    rest: z
      .array(
        z
          .object({
            mode: z.enum(['client', 'server']),
            documentation: z.string().optional(),
            resource: z
              .array(
                z
                  .object({
                    // R4 binds this to the resource-type code list; the
                    // surface declares the one resource it operates on.
                    type: z.enum(['Claim']),
                    operation: z
                      .array(
                        z
                          .object({
                            name: z.string(),
                            definition: z.string(),
                            documentation: z.string().optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * Any resource, read only far enough to know its type. An entry's own schema
 * is applied by whoever reads it, so one malformed `DocumentReference` does
 * not make the whole bundle unreadable.
 */
export const AnyResourceSchema: z.ZodType<FhirResource> = z.custom<FhirResource>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { resourceType?: unknown }).resourceType === 'string',
  { message: 'expected a FHIR resource with a string resourceType' },
);

/**
 * `Claim/$inquire`'s output (P3-E): one `return` parameter per matching case,
 * each a response bundle.
 */
export const ParametersSchema: z.ZodType<Parameters> = z
  .object({
    resourceType: z.literal('Parameters'),
    ...resourceBase,
    parameter: z
      .array(
        z
          .object({
            name: z.string(),
            resource: AnyResourceSchema.optional(),
          })
          .passthrough(),
      )
      .min(1)
      .optional(),
  })
  .passthrough();

export const BundleSchema: z.ZodType<Bundle<FhirResource>> = z
  .object({
    resourceType: z.literal('Bundle'),
    ...resourceBase,
    identifier: IdentifierSchema.optional(),
    type: z.enum([
      'document',
      'message',
      'transaction',
      'transaction-response',
      'batch',
      'batch-response',
      'history',
      'searchset',
      'collection',
    ]),
    timestamp: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            fullUrl: z.string().optional(),
            resource: AnyResourceSchema.optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type FhirPatient = z.infer<typeof PatientSchema>;
export type FhirCoverage = z.infer<typeof CoverageSchema>;
export type FhirPractitioner = z.infer<typeof PractitionerSchema>;
export type FhirOrganization = z.infer<typeof OrganizationSchema>;
export type FhirCondition = z.infer<typeof ConditionSchema>;
export type FhirDocumentReference = z.infer<typeof DocumentReferenceSchema>;
export type PasClaim = z.infer<typeof ClaimSchema>;
export type PasClaimResponse = z.infer<typeof ClaimResponseSchema>;
export type FhirOperationOutcome = z.infer<typeof OperationOutcomeSchema>;
export type FhirCapabilityStatement = z.infer<typeof CapabilityStatementSchema>;
export type FhirBundle = z.infer<typeof BundleSchema>;
export type FhirParameters = z.infer<typeof ParametersSchema>;
