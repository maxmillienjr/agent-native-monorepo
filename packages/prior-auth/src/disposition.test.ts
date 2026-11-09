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
  reconsiderationCredentials: ['synthetic-physician'],
  requestType: 'item-or-service',
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

  it('refers when a met finding cites one resolving and one unresolved reference', () => {
    const disposition = decideDisposition(
      policy,
      [
        finding('c1', 'met', ['Condition/cond-1']),
        finding('c2', 'met', ['DocumentReference/doc-invented', 'DocumentReference/doc-1']),
      ],
      inBundle,
    );
    expect(disposition.kind).toBe('refer-to-clinician');
    if (disposition.kind !== 'refer-to-clinician') return;
    expect(disposition.findings[0]).toMatchObject({ criterionId: 'c1', status: 'met' });
    expect(disposition.findings[1]).toEqual({
      criterionId: 'c2',
      status: 'insufficient',
      evidence: ['DocumentReference/doc-1'],
      rationale:
        'the finding was met, but one or more of its citations names no resource in this request. ' +
        'Model rationale: synthetic rationale',
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

  it('keeps a not-met or insufficient finding’s status, drops its unresolved citation and says so', () => {
    for (const status of ['not-met', 'insufficient'] as const) {
      const [normalized] = normalizeFindings(
        policy,
        [finding('c1', status, ['DocumentReference/doc-invented', 'Condition/cond-1'])],
        inBundle,
      );
      expect(normalized, status).toEqual({
        criterionId: 'c1',
        status,
        evidence: ['Condition/cond-1'],
        rationale:
          '1 cited reference(s) named no resource in this request and were removed. ' +
          'Model rationale: synthetic rationale',
      });
    }
  });

  it('leaves the rationale of a finding whose citations all resolve as the model wrote it', () => {
    const [normalized] = normalizeFindings(
      policy,
      [finding('c1', 'not-met', ['Condition/cond-1'])],
      inBundle,
    );
    expect(normalized?.rationale).toBe('synthetic rationale');
  });
});

/**
 * P3-G tightened the citation rule. The enumeration is the proof that it
 * cannot approve a request the rule it replaced referred: every combination
 * of status and citation set, for each of two criteria, 12 × 12 = 144 cases.
 */
describe('the citation rule, against the one it replaced', () => {
  const STATUSES = ['met', 'not-met', 'insufficient'] as const;
  const RESOLVING = 'Condition/cond-1';
  const UNRESOLVED = 'Observation/elsewhere';
  const CITATIONS: Record<string, string[]> = {
    none: [],
    resolving: [RESOLVING],
    unresolved: [UNRESOLVED],
    both: [RESOLVING, UNRESOLVED],
  };

  /** P3-D's rule: every criterion met with at least one citation in the bundle. */
  const approvedBefore = (findings: readonly CriterionFinding[]): boolean =>
    policy.criteria.every((criterion) => {
      const found = findings.find((candidate) => candidate.criterionId === criterion.id);
      return (
        found?.status === 'met' && found.evidence.some((reference) => inBundle.includes(reference))
      );
    });

  const cases = STATUSES.flatMap((status) =>
    Object.entries(CITATIONS).map(([citations, evidence]) => ({ status, citations, evidence })),
  );
  const requests = cases.flatMap((first) => cases.map((second) => [first, second] as const));

  it('covers 144 requests', () => {
    expect(requests).toHaveLength(144);
  });

  it('approves only what the old rule approved, and differs exactly on a met citing beside an invented id', () => {
    const disagreements: string[] = [];
    for (const [first, second] of requests) {
      const findings = [
        finding('c1', first.status, first.evidence),
        finding('c2', second.status, second.evidence),
      ];
      const label = `${first.status}/${first.citations} + ${second.status}/${second.citations}`;
      const before = approvedBefore(findings);
      const after = decideDisposition(policy, findings, inBundle).kind === 'automated-approval';

      if (after) expect(before, label).toBe(true);
      if (before !== after) disagreements.push(label);
    }

    const resolvingMet = ['met/resolving', 'met/both'];
    const expected = resolvingMet
      .flatMap((one) => resolvingMet.map((two) => `${one} + ${two}`))
      .filter((label) => label.includes('both'));
    expect(disagreements.sort()).toEqual(expected.sort());
    expect(disagreements).toHaveLength(3);
  });
});
