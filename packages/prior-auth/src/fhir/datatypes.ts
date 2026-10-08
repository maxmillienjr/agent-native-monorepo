import { z } from 'zod';
import type {
  Address,
  Attachment,
  CodeableConcept,
  Coding,
  ContactPoint,
  HumanName,
  Identifier,
  Meta,
  Period,
  Quantity,
  Reference,
} from 'fhir/r4.js';

/**
 * The FHIR R4 datatypes the prior-authorization surface reads or writes.
 *
 * Each schema covers the elements this package touches and passes the rest
 * through. FHIR permits extensions and elements a subset cannot enumerate, so
 * stripping them would change what a caller sent.
 *
 * Each schema is annotated `z.ZodType<…>` with its `@types/fhir` R4 interface,
 * so a schema that drifts from base R4 (an element of the wrong type, a code
 * outside the element's value set) is a type error under
 * `yarn turbo typecheck`. It is an annotation rather than the `satisfies` P3-D
 * sketched because the inferred type of a nested passthrough schema is too
 * large for `tsc` to write into a declaration file (TS7056). The check is the
 * same assignability, and the exported types are then base R4's own. The HL7
 * validator in `fhir-validate.yml` is what checks the profiles.
 */

export const CodingSchema: z.ZodType<Coding> = z
  .object({
    system: z.string().optional(),
    version: z.string().optional(),
    code: z.string().optional(),
    display: z.string().optional(),
  })
  .passthrough();

export const CodeableConceptSchema: z.ZodType<CodeableConcept> = z
  .object({
    coding: z.array(CodingSchema).optional(),
    text: z.string().optional(),
  })
  .passthrough();

export const PeriodSchema: z.ZodType<Period> = z
  .object({
    start: z.string().optional(),
    end: z.string().optional(),
  })
  .passthrough();

export const IdentifierSchema: z.ZodType<Identifier> = z
  .object({
    use: z.enum(['usual', 'official', 'temp', 'secondary', 'old']).optional(),
    type: CodeableConceptSchema.optional(),
    system: z.string().optional(),
    value: z.string().optional(),
    period: PeriodSchema.optional(),
  })
  .passthrough();

export const ReferenceSchema: z.ZodType<Reference> = z
  .object({
    reference: z.string().optional(),
    type: z.string().optional(),
    identifier: IdentifierSchema.optional(),
    display: z.string().optional(),
  })
  .passthrough();

export const MetaSchema: z.ZodType<Meta> = z
  .object({
    versionId: z.string().optional(),
    lastUpdated: z.string().optional(),
    profile: z.array(z.string()).optional(),
    security: z.array(CodingSchema).optional(),
    tag: z.array(CodingSchema).optional(),
  })
  .passthrough();

export const HumanNameSchema: z.ZodType<HumanName> = z
  .object({
    use: z.enum(['usual', 'official', 'temp', 'nickname', 'anonymous', 'old', 'maiden']).optional(),
    text: z.string().optional(),
    family: z.string().optional(),
    given: z.array(z.string()).optional(),
    prefix: z.array(z.string()).optional(),
    suffix: z.array(z.string()).optional(),
  })
  .passthrough();

export const ContactPointSchema: z.ZodType<ContactPoint> = z
  .object({
    system: z.enum(['phone', 'fax', 'email', 'pager', 'url', 'sms', 'other']).optional(),
    value: z.string().optional(),
    use: z.enum(['home', 'work', 'temp', 'old', 'mobile']).optional(),
  })
  .passthrough();

export const AddressSchema: z.ZodType<Address> = z
  .object({
    use: z.enum(['home', 'work', 'temp', 'old', 'billing']).optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
  })
  .passthrough();

export const AttachmentSchema: z.ZodType<Attachment> = z
  .object({
    contentType: z.string().optional(),
    language: z.string().optional(),
    /** base64, as FHIR's `base64Binary` is. */
    data: z.string().optional(),
    title: z.string().optional(),
    creation: z.string().optional(),
  })
  .passthrough();

export const QuantitySchema: z.ZodType<Quantity> = z
  .object({
    value: z.number().optional(),
    unit: z.string().optional(),
    system: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();
