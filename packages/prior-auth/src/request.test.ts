import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIOR_AUTH_DATASET_DIR } from './dataset/location.js';
import { loadPayer } from './policy.js';
import { evidenceFor, readSubmission } from './request.js';

const payer = loadPayer();

function bundle(
  task: string,
): Record<string, unknown> & { entry: { resource: Record<string, unknown> }[] } {
  return JSON.parse(
    readFileSync(join(PRIOR_AUTH_DATASET_DIR, 'bundles', `${task}.bundle.json`), 'utf8'),
  ) as Record<string, unknown> & { entry: { resource: Record<string, unknown> }[] };
}

describe('readSubmission', () => {
  it('reads a committed bundle', () => {
    const submission = readSubmission(bundle('pa-k0823-all-met-structured'), payer);
    expect(submission.kind).toBe('ok');
    if (submission.kind !== 'ok') return;
    expect(submission.request.hcpcs).toBe('K0823');
    expect(submission.request.priority).toBe('standard');
    expect(submission.request.diagnoses.map((d) => d.code)).toEqual(['G35.D', 'M62.81']);
  });

  it('reads stat as expedited', () => {
    const submission = readSubmission(bundle('pa-e0601-ambiguous'), payer);
    expect(submission.kind === 'ok' && submission.request.priority).toBe('expedited');
  });

  it('answers a body that is not a Bundle as invalid', () => {
    expect(readSubmission({ resourceType: 'Patient' }, payer).kind).toBe('invalid');
    expect(readSubmission('not json at all', payer).kind).toBe('invalid');
  });

  it('answers a Bundle whose first entry is not a Claim as invalid', () => {
    const body = bundle('pa-e0601-all-met-structured');
    body.entry.reverse();
    const submission = readSubmission(body, payer);
    expect(submission.kind).toBe('invalid');
  });

  it('answers a Claim with no item as unprocessable', () => {
    const body = bundle('pa-e0601-all-met-structured');
    delete body.entry[0]?.resource['item'];
    const submission = readSubmission(body, payer);
    expect(submission.kind).toBe('unprocessable');
  });

  it('answers a Claim addressed to another insurer as unprocessable', () => {
    const body = bundle('pa-e0601-all-met-structured');
    const insurer = body.entry.find((entry) => String(entry.resource['id']).startsWith('insurer-'));
    if (insurer === undefined) throw new Error('no insurer');
    insurer.resource['identifier'] = [
      { system: 'https://example.org/fhir/sid/payer-id', value: 'OTHER' },
    ];
    const submission = readSubmission(body, payer);
    expect(submission.kind).toBe('unprocessable');
  });
});

describe('evidenceFor', () => {
  it('lists every condition and decoded note, labelled with the reference a finding cites', () => {
    const submission = readSubmission(bundle('pa-e0601-all-met-structured'), payer);
    if (submission.kind !== 'ok') throw new Error('did not read');
    const evidence = evidenceFor(submission.request);
    expect(evidence.map((item) => item.reference)).toEqual([
      'Condition/condition-e0601-all-met-structured-osa',
      'DocumentReference/doc-e0601-all-met-structured-study',
      'DocumentReference/doc-e0601-all-met-structured-visit',
    ]);
    expect(evidence[1]?.text).toContain('AHI) 31 events per hour');
  });
});
