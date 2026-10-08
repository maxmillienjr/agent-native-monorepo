/**
 * The code and identifier systems this package writes, spelled once.
 *
 * Every system here is on ADR 0008's list, and `scripts/lint-data.mjs` checks
 * the committed data against the same list.
 */
export const SYSTEMS = {
  HCPCS: 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets',
  ICD10CM: 'http://hl7.org/fhir/sid/icd-10-cm',
  ACT_REASON: 'http://terminology.hl7.org/CodeSystem/v3-ActReason',
  PROCESS_PRIORITY: 'http://terminology.hl7.org/CodeSystem/processpriority',
  CLAIM_TYPE: 'http://terminology.hl7.org/CodeSystem/claim-type',
  /** THO's identifier types; `MB` is the member number `$inquire` matches on. */
  IDENTIFIER_TYPE: 'http://terminology.hl7.org/CodeSystem/v2-0203',
  NPI: 'http://hl7.org/fhir/sid/us-npi',
  /** The fictional payer's own case identifiers. RFC 2606 reserves the domain. */
  CASE_ID: 'https://example.org/fhir/sid/prior-auth-case',
  PRE_AUTH_REF: 'https://example.org/fhir/sid/pre-auth-ref',
} as const;

/**
 * `meta.security` on every resource the dataset holds and the surface writes.
 * THO v7.4.0 defines `HTEST` as "simulated or synthetic health data used for
 * testing system capabilities outside of a production or operational system
 * environment".
 */
export const HTEST = {
  system: SYSTEMS.ACT_REASON,
  code: 'HTEST',
  display: 'test health data',
} as const;
