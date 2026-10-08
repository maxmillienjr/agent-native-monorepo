import { describe, expect, it } from 'vitest';
import type { CriterionFinding } from '@repo/determination';
import { decideDisposition, normalizeFindings } from './disposition.js';
import type { Policy } from './policy.js';

const policy: Policy = {
  id: 'synthetic-policy',
  hcpcs: 'E0601',
  service: 'Synthetic service',
  title: 'Synthetic policy',
  version: '1',
  effective: '2026-01-01',
  approvalPeriodDays: 90,
  disclaimer: 'Synthetic. A fixture policy invented for this unit test and nothing else.',
  reviewerCredentials: ['synthetic-physician'],
  criteria: [
    { id: 'c1', title: 'First criterion', requirement: 'Synthetic requirement one.' },
    { id: 'c2', title: 'Second criterion', requirement: 'Synthetic requirement two.' },
  ],
};

const inBundle = ['Condition/cond-1', 'DocumentReference/doc-1'];

const finding = (
  criterionId: string,
  status: CriterionFinding['status'],
  evidence: string[],
): CriterionFinding => ({ criterionId, status, evidence, rationale: 'synthetic rationale' });

describe('decideDisposition', () => {
  it('approves when every criterion is met with a citation that resolves', () => {
    const disposition = decideDisposition(
      policy,
      [
        finding('c1', 'met', ['Condition/cond-1']),
        finding('c2', 'met', ['DocumentReference/doc-1']),
      ],
      inBundle,
    );
    expect(disposition).toEqual({ kind: 'automated-approval', criteriaMet: ['c1', 'c2'] });
  });

  it('refers when one criterion is insufficient', () => {
    const disposition = decideDisposition(
      policy,
      [finding('c1', 'met', ['Condition/cond-1']), finding('c2', 'insufficient', [])],
      inBundle,
    );
    expect(disposition.kind).toBe('refer-to-clinician');
  });

  it('refers when a met finding cites only a resource the bundle does not hold', () => {
    const disposition = decideDisposition(
      policy,
      [finding('c1', 'met', ['Condition/cond-1']), finding('c2', 'met', ['Observation/elsewhere'])],
      inBundle,
    );
    expect(disposition.kind).toBe('refer-to-clinician');
    if (disposition.kind !== 'refer-to-clinician') return;
    expect(disposition.findings[1]).toMatchObject({
      criterionId: 'c2',
      status: 'insufficient',
      evidence: [],
    });
  });

  it('refers when the model returns no finding for a criterion', () => {
    const disposition = decideDisposition(
      policy,
      [finding('c1', 'met', ['Condition/cond-1'])],
      inBundle,
    );
    expect(disposition.kind).toBe('refer-to-clinician');
  });

  it('refers when a criterion is not met, however well the rest is cited', () => {
    const disposition = decideDisposition(
      policy,
      [
        finding('c1', 'met', ['Condition/cond-1']),
        finding('c2', 'not-met', ['DocumentReference/doc-1']),
      ],
      inBundle,
    );
    expect(disposition.kind).toBe('refer-to-clinician');
  });
});

describe('normalizeFindings', () => {
  it('drops a finding for a criterion the policy does not have and keeps policy order', () => {
    const normalized = normalizeFindings(
      policy,
      [
        finding('c2', 'met', ['DocumentReference/doc-1']),
        finding('invented', 'met', ['Condition/cond-1']),
        finding('c1', 'not-met', ['Condition/cond-1', 'Observation/elsewhere']),
      ],
      inBundle,
    );
    expect(normalized.map((f) => f.criterionId)).toEqual(['c1', 'c2']);
    expect(normalized[0]?.evidence).toEqual(['Condition/cond-1']);
  });
});
