import type { FhirBundle } from './fhir/resources.js';
import { resolveReference } from './request.js';
import { SYSTEMS } from './systems.js';

/**
 * The keys a case is found by: `$inquire` matches by example on the member,
 * the insurer and the provider (P3-E), and these are what it compares.
 *
 * Each key is an identifier written as a FHIR token, `system|value`, so two
 * identifiers with the same value in different systems never match. An
 * identifier with no system or no value is not a key.
 */
export type IdentifierLike = {
  readonly system?: string | undefined;
  readonly value?: string | undefined;
  readonly type?:
    { readonly coding?: readonly { system?: string; code?: string }[] | undefined } | undefined;
};

export function identifierKey(identifier: IdentifierLike | undefined): string | undefined {
  if (identifier?.system === undefined || identifier.value === undefined) return undefined;
  if (identifier.system === '' || identifier.value === '') return undefined;
  return `${identifier.system}|${identifier.value}`;
}

/** Whether an identifier is typed `MB`, member number, in THO's `v2-0203` (ADR 0008). */
function isMemberNumber(identifier: IdentifierLike): boolean {
  return (identifier.type?.coding ?? []).some(
    (coding) => coding.system === SYSTEMS.IDENTIFIER_TYPE && coding.code === 'MB',
  );
}

type ReferenceLike = {
  readonly reference?: string | undefined;
  readonly identifier?: IdentifierLike | undefined;
};

function identifiersOf(bundle: FhirBundle, reference: ReferenceLike | undefined): IdentifierLike[] {
  if (reference === undefined) return [];
  const resource = resolveReference(bundle, reference.reference) as
    { identifier?: IdentifierLike[] } | undefined;
  return [
    ...(resource?.identifier ?? []),
    ...(reference.identifier === undefined ? [] : [reference.identifier]),
  ];
}

/**
 * The patient's member identifier: the one typed `MB`, on the resource the
 * reference resolves to in this bundle, or on the reference itself.
 */
export function memberKeyOf(
  bundle: FhirBundle,
  patient: ReferenceLike | undefined,
): string | undefined {
  return identifiersOf(bundle, patient)
    .filter(isMemberNumber)
    .map(identifierKey)
    .find((key) => key !== undefined);
}

/**
 * An insurer's or a provider's key: its first identifier with a system and a
 * value, preferring one in `preferSystem` when given, so the payer is keyed
 * by the identifier it is known by.
 */
export function partyKeyOf(
  bundle: FhirBundle,
  party: ReferenceLike | undefined,
  preferSystem?: string,
): string | undefined {
  const identifiers = identifiersOf(bundle, party);
  const preferred =
    preferSystem === undefined
      ? []
      : identifiers.filter((identifier) => identifier.system === preferSystem);
  return [...preferred, ...identifiers].map(identifierKey).find((key) => key !== undefined);
}
