import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIOR_AUTH_DATASET_DIR } from './dataset/location.js';
import { ParametersSchema } from './fhir/resources.js';
import {
  AUTHORIZATION_NUMBER_EXTENSION,
  inquiryMatches,
  inquiryResult,
  readInquiry,
} from './inquiry.js';
import { loadPayer } from './policy.js';
import { readSubmission } from './request.js';

const payer = loadPayer();

type Resource = Record<string, unknown>;
type Body = Resource & { entry: { resource: Resource }[] };

function bundle(task: string): Body {
  return JSON.parse(
    readFileSync(join(PRIOR_AUTH_DATASET_DIR, 'bundles', `${task}.bundle.json`), 'utf8'),
  ) as Body;
}

const MEMBER = 'https://example.org/fhir/sid/member-id|QHP-M-1001';
const INSURER = 'https://example.org/fhir/sid/payer-id|QHP-SYN-001';
const PROVIDER = 'https://example.org/fhir/sid/supplier-id|SUP-01';

describe('the case keys a submission is enqueued under', () => {
  it('are the member identifier typed MB, the payer and the provider', () => {
    const submission = readSubmission(bundle('pa-e0601-all-met-structured'), payer);
    expect(submission.kind).toBe('ok');
    if (submission.kind !== 'ok') return;
    expect(submission.request.memberId).toBe(MEMBER);
    expect(submission.request.insurerId).toBe(INSURER);
    expect(submission.request.providerId).toBe(PROVIDER);
  });

  it('refuse a patient with no member identifier as unprocessable', () => {
    const body = bundle('pa-e0601-all-met-structured');
    const patient = body.entry.find((entry) => entry.resource['resourceType'] === 'Patient');
    if (patient === undefined) throw new Error('no patient');
    delete patient.resource['identifier'];
    expect(readSubmission(body, payer).kind).toBe('unprocessable');
  });
});

describe('readInquiry', () => {
  it('reads a request bundle as an example: member, insurer, provider and item', () => {
    const reading = readInquiry(bundle('pa-e0601-all-met-structured'), payer);
    expect(reading).toEqual({
      kind: 'ok',
      inquiry: {
        memberId: MEMBER,
        insurerId: INSURER,
        providerId: PROVIDER,
        items: [{ hcpcs: 'E0601' }],
      },
    });
  });

  it('does not read the inquiry Claim.identifier', () => {
    const body = bundle('pa-e0601-all-met-structured');
    const first = readInquiry(body, payer);
    const claim = body.entry[0]?.resource;
    if (claim === undefined) throw new Error('no claim');
    claim['identifier'] = [{ system: 'https://example.org/fhir/sid/inquiry', value: 'INQ-2' }];
    expect(readInquiry(body, payer)).toEqual(first);
  });

  it('reads an authorization number from the PAS item extension', () => {
    const body = bundle('pa-e0601-all-met-structured');
    const claim = body.entry[0]?.resource as { item: Resource[] };
    claim.item[0] = {
      ...claim.item[0],
      extension: [{ url: AUTHORIZATION_NUMBER_EXTENSION, valueString: 'case-123' }],
    };
    const reading = readInquiry(body, payer);
    expect(reading.kind === 'ok' && reading.inquiry.items).toEqual([
      { hcpcs: 'E0601', authorizationNumber: 'case-123' },
    ]);
  });

  it('answers a body that is not a Bundle, or a Bundle without a Claim first, as invalid', () => {
    expect(readInquiry({ resourceType: 'Patient' }, payer).kind).toBe('invalid');
    const body = bundle('pa-e0601-all-met-structured');
    body.entry.reverse();
    const reading = readInquiry(body, payer);
    expect(reading.kind).toBe('invalid');
    expect(reading.kind === 'invalid' && reading.issues[0]?.diagnostics).toContain('$inquire');
  });

  it('answers an inquiry with nothing to match on as unprocessable, naming each gap', () => {
    const body = bundle('pa-e0601-all-met-structured');
    for (const entry of body.entry) delete entry.resource['identifier'];
    const claim = body.entry[0]?.resource;
    if (claim === undefined) throw new Error('no claim');
    delete claim['insurer'];
    const reading = readInquiry(body, payer);
    expect(reading.kind).toBe('unprocessable');
    expect(reading.kind === 'unprocessable' && reading.issues.map((i) => i.expression)).toEqual([
      'Claim.patient',
      'Claim.insurer',
      'Claim.provider',
    ]);
  });
});

describe('inquiryMatches', () => {
  const approved = { hcpcs: 'E0601', preAuthRef: 'case-1' };
  const pended = { hcpcs: 'E0601', preAuthRef: undefined };

  it('matches every case when the inquiry has no items', () => {
    expect(inquiryMatches({ items: [] }, pended)).toBe(true);
  });

  it('narrows by code, and by authorization number against the issued preAuthRef', () => {
    expect(inquiryMatches({ items: [{ hcpcs: 'E0470' }] }, approved)).toBe(false);
    expect(inquiryMatches({ items: [{ hcpcs: 'E0601' }] }, approved)).toBe(true);
    const byNumber = { items: [{ hcpcs: 'E0601', authorizationNumber: 'case-1' }] };
    expect(inquiryMatches(byNumber, approved)).toBe(true);
    expect(inquiryMatches(byNumber, pended)).toBe(false);
  });
});

describe('inquiryResult', () => {
  it('returns one return parameter per bundle, and no parameter for no match', () => {
    const none = inquiryResult([]);
    expect(none).toEqual({
      resourceType: 'Parameters',
      meta: { security: [expect.objectContaining({ code: 'HTEST' })] },
    });
    expect(ParametersSchema.safeParse(none).success).toBe(true);

    const two = inquiryResult([
      { resourceType: 'Bundle', type: 'collection' },
      { resourceType: 'Bundle', type: 'collection' },
    ]);
    expect(two.parameter?.map((parameter) => parameter.name)).toEqual(['return', 'return']);
    expect(ParametersSchema.safeParse(two).success).toBe(true);
  });
});
