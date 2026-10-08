import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdverseDetermination, AgentDisposition } from '@repo/determination';
import { toClaimResponse, toDeterminationResponse, toResponseBundle } from './claim-response.js';
import { PRIOR_AUTH_DATASET_DIR } from './dataset/location.js';
import { PolicyCatalogue, loadPayer } from './policy.js';
import { readSubmission, type PriorAuthRequest } from './request.js';

const payer = loadPayer();
const catalogue = PolicyCatalogue.load();

function request(task: string): PriorAuthRequest {
  const body: unknown = JSON.parse(
    readFileSync(join(PRIOR_AUTH_DATASET_DIR, 'bundles', `${task}.bundle.json`), 'utf8'),
  );
  const submission = readSubmission(body, payer);
  if (submission.kind !== 'ok') throw new Error(`${task} did not read`);
  return submission.request;
}

const structured = request('pa-e0601-all-met-structured');
const policy = catalogue.forCode('E0601');
const context = { respondedAt: new Date('2026-09-21T10:00:00Z'), caseId: 'case-synthetic-1' };

const approval: AgentDisposition = {
  kind: 'automated-approval',
  criteriaMet: (policy?.criteria ?? []).map((criterion) => criterion.id),
};
const SENTINEL = 'SENTINEL-MODEL-RATIONALE-7f3a';
const referral: AgentDisposition = {
  kind: 'refer-to-clinician',
  findings: (policy?.criteria ?? []).map((criterion) => ({
    criterionId: criterion.id,
    status: 'insufficient' as const,
    evidence: [],
    rationale: `${SENTINEL} for ${criterion.id}`,
  })),
};

describe('toClaimResponse', () => {
  it('throws on a cast adverse determination rather than mapping it', () => {
    const forged = {
      kind: 'denial',
      specificReason: 'Synthetic fixture: forged.',
      attestation: {
        reviewerId: 'synthetic-reviewer-001',
        credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
        attestedAt: '2026-09-26T14:00:00+00:00',
      },
    } as unknown as AdverseDetermination as unknown as AgentDisposition;

    expect(() => toClaimResponse(structured.claim, forged, policy, context)).toThrow();
  });

  it('maps both variants to complete or queued, and to nothing else', () => {
    const approved = toClaimResponse(structured.claim, approval, policy, context);
    const referred = toClaimResponse(structured.claim, referral, policy, context);

    expect(approved.outcome).toBe('complete');
    expect(approved.preAuthRef).toBe('case-synthetic-1');
    expect(approved.preAuthPeriod).toEqual({ start: '2026-09-21', end: '2026-12-19' });

    expect(referred.outcome).toBe('queued');
    expect(referred.preAuthRef).toBeUndefined();
    expect(referred.preAuthPeriod).toBeUndefined();

    for (const response of [approved, referred]) {
      expect(['complete', 'queued']).toContain(response.outcome);
      expect(JSON.stringify(response)).not.toMatch(/\bden(y|ied|ial)\b/i);
      expect(response.identifier).toEqual([
        { system: 'https://example.org/fhir/sid/prior-auth-case', value: 'case-synthetic-1' },
      ]);
      expect(response.meta?.security?.[0]?.code).toBe('HTEST');
    }
  });

  it('carries no model text: a sentinel in every rationale never reaches the response', () => {
    const referred = toClaimResponse(structured.claim, referral, policy, context);
    const bundle = toResponseBundle(structured.bundle, referred, context);
    expect(JSON.stringify(bundle)).not.toContain(SENTINEL);
    // The note names criteria by their policy titles instead.
    expect(referred.processNote?.[0]?.text).toContain('Apnea-hypopnea index of 18 or more');
  });

  it('states the administrative reason from a template', () => {
    const referred = toClaimResponse(
      structured.claim,
      { kind: 'refer-to-clinician', findings: [] },
      policy,
      { ...context, referralReason: 'coverage-inactive' },
    );
    expect(referred.outcome).toBe('queued');
    expect(referred.processNote?.[0]?.text).toContain('not active on the date of service');
  });
});

describe('toDeterminationResponse', () => {
  const attestation = {
    reviewerId: 'synthetic-reviewer-001',
    credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
    attestedAt: '2026-10-08T12:00:00+00:00',
  };
  const decided = { decidedAt: new Date('2026-09-23T15:00:00Z'), caseId: 'case-synthetic-2' };
  const REASON = 'Synthetic: the sleep study is older than twelve months.';
  // A denial built the way attestAdverseDetermination builds one. The brand is
  // a type, so the unit test casts; the route mints it through ./clinician.
  const denial = {
    kind: 'denial',
    specificReason: REASON,
    attestation,
  } as unknown as AdverseDetermination;

  it('answers a clinician approval with complete, a preAuthRef and the period', () => {
    const approved = toDeterminationResponse(
      structured.claim,
      { kind: 'clinician-approval', attestation },
      policy,
      decided,
    );
    expect(approved.outcome).toBe('complete');
    expect(approved.preAuthRef).toBe('case-synthetic-2');
    expect(approved.preAuthPeriod).toEqual({ start: '2026-09-21', end: '2026-12-19' });
    expect(approved.created).toBe('2026-09-23T15:00:00.000Z');
  });

  it('answers a denial with complete, no preAuthRef and the specific reason in a note', () => {
    const denied = toDeterminationResponse(structured.claim, denial, policy, decided);
    expect(denied.outcome).toBe('complete');
    expect(denied.preAuthRef).toBeUndefined();
    expect(denied.preAuthPeriod).toBeUndefined();
    expect(denied.processNote).toEqual([{ number: 1, type: 'display', text: REASON }]);
    expect(denied.identifier?.[0]?.value).toBe('case-synthetic-2');
    expect(denied.meta?.security?.[0]?.code).toBe('HTEST');
  });

  it('carries nothing of the reviewer: who decided stays on the case', () => {
    for (const response of [
      toDeterminationResponse(structured.claim, denial, policy, decided),
      toDeterminationResponse(
        structured.claim,
        { kind: 'clinician-approval', attestation },
        policy,
        decided,
      ),
    ]) {
      expect(JSON.stringify(response)).not.toContain('synthetic-reviewer-001');
    }
  });

  it('refuses a partial approval and an automated approval', () => {
    const partial = { ...denial, kind: 'partial-approval' } as unknown as AdverseDetermination;
    expect(() => toDeterminationResponse(structured.claim, partial, policy, decided)).toThrow();
    const automated = approval as unknown as AdverseDetermination;
    expect(() => toDeterminationResponse(structured.claim, automated, policy, decided)).toThrow();
  });
});

describe('toResponseBundle', () => {
  it('puts the ClaimResponse first and carries the resources it references', () => {
    const referred = toClaimResponse(structured.claim, referral, policy, context);
    const bundle = toResponseBundle(structured.bundle, referred, context);
    expect(bundle.type).toBe('collection');
    expect(bundle.entry?.[0]?.resource?.resourceType).toBe('ClaimResponse');
    expect(bundle.entry?.map((entry) => entry.resource?.resourceType)).toEqual([
      'ClaimResponse',
      'Patient',
      'Organization',
      'Organization',
    ]);
  });
});
