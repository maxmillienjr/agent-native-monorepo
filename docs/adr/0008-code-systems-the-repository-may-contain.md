# 0008 · The code systems this repository may contain

**Status:** accepted
**Date:** 2026-10-08

## Context

[ADR 0003](0003-payer-domain-with-licensing-and-phi-as-the-boundary.md) draws the boundary
at licensed content and names three code systems: CPT is forbidden, and ICD-10-CM and HCPCS
Level II are permitted because they "are freely redistributable". P3-D commits the first
payer data, FHIR bundles whose `Coding` elements name a code system each, and
`scripts/lint-data.mjs` checks every `Coding.system` against a list. ADR 0003's three names
are not a complete list, and its licence sentence was asserted without a citation. Both
gaps had to be closed before a dataset file was written.

### What the primary sources say, read 2026-10-08

**ICD-10-CM.** NCHS publishes it, under an authorization from WHO, which owns ICD-10. WHO's
licensing FAQ disclaims the national modifications and sends anyone who wants a licence for
the US Clinical Modification to NCHS. NCHS publishes no licence of its own. The FY2026 and
FY2027 release archives on `ftp.cdc.gov` (code descriptions, tabular list and index, in
text, PDF and XML) carry no copyright or licence notice. The ICD-10-CM page on
`cdc.gov/nchs` carries only the WHO sentence. What governs NCHS material is CDC's agency
policy, "Use of CDC/ATSDR materials", which says most CDC information "may be freely used
or reproduced without obtaining copyright permission", on four conditions:

1. attribute the material to the agency that developed it;
2. state that the use implies no endorsement by CDC, HHS or the US Government;
3. do not change the substantive content;
4. state that the material is available on the agency website at no charge.

HL7's own CARIN Blue Button guide reproduces exactly that text as the `copyright` of its
ICD-10-CM value set. So ICD-10-CM is public domain with conditions, not unconditionally
"freely redistributable". The conditions are met by the notice at the end of this record and
by copying each descriptor from the release file unchanged.

**HCPCS Level II.** CMS maintains it under a delegation from the Secretary of HHS (42 CFR
§ 414.40(a); 45 CFR § 162.1002 adopts it). Neither the HCPCS overview page, the quarterly
update page nor the alpha-numeric page states a licence. The October 2026 alpha-numeric
file's record layout, `HCPC2026_recordlayout.txt`, does state copyright, in two places and
only two:

- Level I: "Codes and descriptors copyrighted by the American Medical Association's current
  procedural terminology … Any other use violates the AMA copyright."
- Level II: "Includes codes and descriptors copyrighted by the American Dental
  Association's current dental terminology, (CDT-2024). These are 5 position alpha-numeric
  codes comprising the d series."

CMS's "HCPCS Level II Coding Procedures" says the same of the D codes: "CDT codes are
published and copyrighted by the ADA". CMS claims no copyright in the rest of Level II,
which is a work of a federal agency, and 17 U.S.C. § 105 puts that outside copyright. So
HCPCS Level II outside the D range is free to reproduce, and the D range is ADA-licensed
content that ADR 0003's own boundary excludes. ADR 0003's sentence is wrong for one letter
of the alphabet.

Neither finding is restrictive for anything Tier 3 needs. The dataset uses four E and K
codes and a handful of ICD-10-CM diagnoses. Each was checked against the October 2026
HCPCS file and the FY2027 ICD-10-CM code file.

## Decision

`Coding.system` in any payer data in this repository is one of the systems below, and a
system not on the list is forbidden until this record is amended. A system is added only
after a reviewer has read its licence and cited it here.

| System                           | URI in `Coding.system`                                                                 | Decision   | Basis                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| ICD-10-CM                        | `http://hl7.org/fhir/sid/icd-10-cm`                                                    | permitted  | CDC's public-domain policy, on its four conditions; see the notice below                                        |
| HCPCS Level II, A-C and E-V      | `http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets`                              | permitted  | A CMS work with no copyright claimed. THO's preferred URI; its retired `HCPCS-all-codes` URI is not on the list |
| HCPCS Level II, D range (CDT)    | the same URI                                                                           | forbidden  | ADA copyright, stated in CMS's own record layout                                                                |
| CMS Place of Service             | `https://www.cms.gov/Medicare/Coding/place-of-service-codes/Place_of_Service_Code_Set` | permitted  | A CMS publication; one of the two systems PAS admits for `item.location[x]`                                     |
| HL7 terminology (THO), FHIR core | `http://terminology.hl7.org/CodeSystem/*`, `http://hl7.org/fhir/*`                     | permitted  | HL7 publishes both for use in exchanges. `HTEST` and `process-priority` come from here                          |
| Local synthetic                  | `https://example.org/*`                                                                | permitted  | RFC 2606 reserved domain; the fictional payer's own codes                                                       |
| CPT / HCPCS Level I              | `http://www.ama-assn.org/go/cpt`                                                       | forbidden  | ADR 0003 decision 2, restated                                                                                   |
| X12 code lists                   | `https://codesystem.x12.org/*`                                                         | forbidden  | "All X12 work products are copyrighted" (PAS value sets); X12 runs a licensing programme                        |
| NUBC                             | `https://www.nubc.org/*`                                                               | forbidden  | AHA copyright; use in software "must be properly licensed" (PAS IP statement)                                   |
| SNOMED CT                        | `http://snomed.info/sct`                                                               | forbidden  | Free in the US under the UMLS licence; public redistribution not settled by NLM's text                          |
| LOINC, RxNorm                    | —                                                                                      | not listed | Both are usable with notice or attribution, and the dataset needs neither. Adding one amends this record        |

Three rules follow, and `scripts/lint-data.mjs` checks each one in payer data:

- **D1.** Every `Coding.system` is a permitted system above. The CPT URI fails by name; an
  unknown URI fails so that adding one is a decision a reviewer sees.
- **D2.** A code under the HCPCS URI matches `^[A-CE-V][0-9]{4}$`. A five-digit code there
  is Level I, which is CPT, and a D code is CDT.
- **D3.** A code under the ICD-10-CM URI has the ICD-10-CM shape: a letter, two characters,
  and an optional dot followed by one to four more.

X12 code values stay out of the repository. P3-D asked whether a handful in fixtures would
be acceptable use, and its review decided they would not, so its FHIR surface is shaped
after PAS 2.2.1 and does not conform to it.

## Consequences

- This record extends ADR 0003 and narrows one sentence of it. CPT stays forbidden,
  ICD-10-CM stays permitted, and HCPCS Level II stays permitted outside its D range. The D
  range is forbidden for the reason ADR 0003 gives for CPT: it is licensed content, and the
  boundary is licensed content. ADR 0003 is not superseded. Its decision is unchanged, and
  only the premise that every Level II code is free turned out to be wrong.
- `.agents/reviewer.md` keeps the half no detector can check: proprietary policy text, and
  real PHI that is shaped to look synthetic. CTL-DATA-02 in `governance/controls.yaml` is that
  procedural rule.
- A dataset that later needs LOINC for a measurement, or RxNorm for a drug, amends this
  table first, with the licence text read and cited, and then the allowlist in
  `lint-data.mjs`.
- The ICD-10-CM conditions travel with the data. The notice below is repeated in the
  fictional payer's `data/payer.json` so a reader of the dataset meets it without finding
  this record.

## Notice

ICD-10-CM codes and descriptors in this repository are from the International
Classification of Diseases, Tenth Revision, Clinical Modification, developed by the National
Center for Health Statistics (Source: CDC/NCHS), under authorization from the World Health
Organization, which owns ICD-10. Their use here does not imply endorsement by CDC, NCHS,
HHS or the United States Government of this repository or anyone who uses it. Each
descriptor is reproduced unchanged. ICD-10-CM is available at no charge on the NCHS
website. HCPCS Level II codes and descriptors are from the Centers for Medicare & Medicaid
Services' alpha-numeric HCPCS file.

## References

Every source below was read on 2026-10-08.

- CDC, "Use of CDC/ATSDR materials" (agency copyright policy),
  <https://www.cdc.gov/other/agencymaterials.html>
- NCHS, ICD-10-CM, <https://www.cdc.gov/nchs/icd/icd-10-cm/index.html>, and the FY2026 and
  FY2027 release archives under
  <https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/>
- WHO, FAQ on licensing ICD-10, section X,
  <https://cdn.who.int/media/docs/default-source/publishing-policies/copyright/who-faq-licensing-icd-10.pdf>
- HL7 CARIN Blue Button STU1, `ValueSet-CDCICD910CMDiagnosisCodes`, `copyright` element,
  <https://www.hl7.org/fhir/us/carin-bb/STU1/ValueSet-CDCICD910CMDiagnosisCodes.json>
- CMS, HCPCS quarterly update and the October 2026 alpha-numeric file,
  <https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system/quarterly-update>.
  The record layout is `HCPC2026_recordlayout.txt` inside
  <https://www.cms.gov/files/zip/october-2026-alpha-numeric-hcpcs-file.zip>
- CMS, "HCPCS Level II Coding Procedures",
  <https://www.cms.gov/files/document/hcpcsleveliicodingprocedures-updated-nov132015pdf>
- 17 U.S.C. § 105, subject matter of copyright: United States Government works
- HL7 Da Vinci PAS 2.2.1, value-set and IP statements, <https://hl7.org/fhir/us/davinci-pas/2.2.1/en/>
- NLM, SNOMED CT licensing, <https://www.nlm.nih.gov/healthit/snomedct/snomed_licensing.html>
- RFC 2606, reserved top-level DNS names
- `docs/prd/P3-D-payer-dataset-fhir-prior-auth.md`, which proposed the table this record
  decides and the licence research it records
