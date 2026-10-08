/**
 * The PAS report's classifier (scripts/fhir-validate.mjs). The messages are the
 * validator 6.10.4's own wording, from a run over the committed bundles; an
 * error the classes do not name must come out as `other`, which is the list a
 * reviewer reads in the job summary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPasError } from './fhir-validate.mjs';

const PAS = 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition';

test('the X12-bound elements are classed as X12', () => {
  assert.equal(
    classifyPasError(
      `Slice 'Claim.item.extension:requestType' for extension '${PAS}/extension-serviceItemRequestType': a matching slice is required, but not found`,
    ),
    'x12: item.extension requestType',
  );
  assert.equal(
    classifyPasError(
      `Slice 'Claim.item.extension:certificationType' for extension '${PAS}/extension-certificationType': a matching slice is required, but not found`,
    ),
    'x12: item.extension certificationType',
  );
  assert.equal(
    classifyPasError(
      `Claim.item.category: minimum required = 1, but only found 0 (from ${PAS}/profile-claim|2.2.1)`,
    ),
    'x12: item.category',
  );
  assert.equal(
    classifyPasError(
      "The value provided ('queued') was not found in the value set 'Claim Response Outcome' (http://hl7.org/fhir/us/davinci-pas/ValueSet/ClaimResponseOutcome|2.2.1)",
    ),
    'x12: outcome queued',
  );
});

test('an error the classes do not name is other', () => {
  assert.equal(
    classifyPasError(
      "Constraint failed: self-beneficiary: 'If relationship does not equal 'self', then subscriber SHALL be present.'",
    ),
    'other',
  );
  assert.equal(classifyPasError('Invalid Resource target type. Found Practitioner'), 'other');
});
