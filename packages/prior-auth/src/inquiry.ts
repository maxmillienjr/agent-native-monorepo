import { memberKeyOf, partyKeyOf } from './case-keys.js';
import type { FhirBundle, FhirParameters } from './fhir/resources.js';
import type { Payer } from './policy.js';
import { readClaimBundle, type SubmissionIssue } from './request.js';
import { HTEST, SYSTEMS } from './systems.js';

/**
 * PAS's item-level extension that carries an authorization number the payer
 * issued. On an inquiry it narrows the match to the case whose `preAuthRef`
 * it names.
 */
export const AUTHORIZATION_NUMBER_EXTENSION =
  'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-authorizationNumber';

/** One item of an inquiry: what it narrows the match to. Either field may be absent. */
export interface InquiryItem {
  readonly hcpcs?: string;
  readonly authorizationNumber?: string;
}

/**
 * A `Claim/$inquire` body, read as an example to match cases against (P3-E).
 *
 * PAS defines the operation as query by example. The inquiry `Claim`'s own
 * identifier "is used to identify the inquiry itself and is not used in
 * searches for previous authorizations", so it is not read. What is matched is
 * the patient's member identifier, the insurer and the provider, each 1..1 in
 * PAS's inquiry profile, and, when the inquiry has items, each item's HCPCS
 * code and authorization number.
 */
export interface Inquiry {
  readonly memberId: string;
  readonly insurerId: string;
  readonly providerId: string;
  readonly items: readonly InquiryItem[];
}

export type InquiryReading =
  | { readonly kind: 'ok'; readonly inquiry: Inquiry }
  | { readonly kind: 'invalid'; readonly issues: readonly SubmissionIssue[] }
  | { readonly kind: 'unprocessable'; readonly issues: readonly SubmissionIssue[] };

/**
 * Reads an inquiry, or says why it cannot: `invalid` (400) for a body that is
 * not a `Bundle` with a `Claim` first, `unprocessable` (422) for one with no
 * member identifier, insurer or provider to match on.
 */
export function readInquiry(body: unknown, payer: Payer): InquiryReading {
  const read = readClaimBundle(body, '$inquire');
  if (read.kind === 'invalid') return read;
  const { bundle, claim } = read;

  const memberId = memberKeyOf(bundle, claim.patient);
  const insurerId = partyKeyOf(bundle, claim.insurer, payer.payer.identifier.system);
  const providerId = partyKeyOf(bundle, claim.provider);

  const issues: SubmissionIssue[] = [];
  if (memberId === undefined) {
    issues.push({
      code: 'required',
      diagnostics: 'Claim.patient carries no member identifier typed MB to match on',
      expression: 'Claim.patient',
    });
  }
  if (insurerId === undefined) {
    issues.push({
      code: 'required',
      diagnostics: 'Claim.insurer carries no identifier with a system and a value to match on',
      expression: 'Claim.insurer',
    });
  }
  if (providerId === undefined) {
    issues.push({
      code: 'required',
      diagnostics: 'Claim.provider carries no identifier with a system and a value to match on',
      expression: 'Claim.provider',
    });
  }
  if (memberId === undefined || insurerId === undefined || providerId === undefined) {
    return { kind: 'unprocessable', issues };
  }

  const items = (claim.item ?? []).map((item): InquiryItem => {
    const hcpcs = item.productOrService.coding?.find(
      (coding) => coding.system === SYSTEMS.HCPCS,
    )?.code;
    const authorizationNumber = item.extension?.find(
      (extension) => extension.url === AUTHORIZATION_NUMBER_EXTENSION,
    )?.valueString;
    return {
      ...(hcpcs === undefined ? {} : { hcpcs }),
      ...(authorizationNumber === undefined ? {} : { authorizationNumber }),
    };
  });

  return { kind: 'ok', inquiry: { memberId, insurerId, providerId, items } };
}

/**
 * Whether a case the keys matched also matches the inquiry's items. With no
 * items, every case for the member, insurer and provider does. Otherwise a
 * case matches when some item's code is the case's and, if the item names an
 * authorization number, it is the `preAuthRef` the case was issued.
 */
export function inquiryMatches(
  inquiry: Pick<Inquiry, 'items'>,
  candidate: { readonly hcpcs: string; readonly preAuthRef: string | undefined },
): boolean {
  if (inquiry.items.length === 0) return true;
  return inquiry.items.some(
    (item) =>
      (item.hcpcs === undefined || item.hcpcs === candidate.hcpcs) &&
      (item.authorizationNumber === undefined || item.authorizationNumber === candidate.preAuthRef),
  );
}

/**
 * The operation's output: a `Parameters` with one `return` per matching case,
 * each that case's response bundle as it stands. FHIR JSON has no empty
 * arrays, so no match is a `Parameters` with no `parameter` at all.
 */
export function inquiryResult(bundles: readonly FhirBundle[]): FhirParameters {
  return {
    resourceType: 'Parameters',
    meta: { security: [{ ...HTEST }] },
    ...(bundles.length === 0
      ? {}
      : { parameter: bundles.map((bundle) => ({ name: 'return', resource: bundle })) }),
  };
}
