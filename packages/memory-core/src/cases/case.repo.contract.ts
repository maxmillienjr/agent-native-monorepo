import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CaseRepository, Decision, NewCase } from './case.repo.js';

/**
 * One contract, two stores (P3-E). `in-memory.repo.test.ts` runs it against
 * `InMemoryCaseRepository` under `test:unit`, and
 * `test/cases.integration.test.ts` against `DrizzleCaseRepository` on a real
 * Postgres under `test:integration`. `fresh` returns a repository holding no
 * cases; it is called before every test.
 *
 * Every fixture is synthetic (ADR 0003): the reviewer, the credential and the
 * identifiers name no real person, board or payer.
 */
export function describeCaseRepositoryContract(
  name: string,
  fresh: () => Promise<CaseRepository>,
): void {
  describe(`CaseRepository contract: ${name}`, () => {
    let repo: CaseRepository;
    beforeEach(async () => {
      repo = await fresh();
    });

    it('round-trips a case: clock, keys, documents and disposition', async () => {
      const row = pended({ request: { resourceType: 'Bundle', z: 1, a: [{ b: 2 }] } });
      await repo.enqueue(row);

      const stored = await repo.get(row.caseId);
      expect(stored).not.toBeNull();
      expect(stored?.status).toBe('pended');
      expect(stored?.receivedAt.toISOString()).toBe(row.receivedAt.toISOString());
      expect(stored?.decisionDueBy.toISOString()).toBe(row.decisionDueBy.toISOString());
      expect(stored?.request).toEqual(row.request);
      // The request is stored as received: key order survives the round trip.
      expect(JSON.stringify(stored?.request)).toBe(JSON.stringify(row.request));
      expect(stored?.disposition).toEqual(row.disposition);
      expect(stored?.determination).toBeNull();
      expect(stored?.overdueFlaggedAt).toBeNull();
    });

    it('rejects a second case with the same id', async () => {
      const row = pended();
      await repo.enqueue(row);
      await expect(repo.enqueue({ ...row })).rejects.toThrow();
    });

    it('refuses a referral enqueued as an approval', async () => {
      await expect(repo.enqueue({ ...pended(), status: 'approved-automated' })).rejects.toThrow(
        /enqueued as pended/,
      );
    });

    it('returns null for an unknown case id and for one that is not a uuid', async () => {
      expect(await repo.get(randomUUID())).toBeNull();
      expect(await repo.get('not-a-case')).toBeNull();
    });

    it('queues pended cases only, by deadline, then receipt, then case id', async () => {
      const due = (iso: string) => new Date(iso);
      const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
      const standardEarly = pended({
        receivedAt: due('2025-01-01T08:00:00Z'),
        decisionDueBy: due('2025-01-08T09:00:00Z'),
      });
      const tieB = pended({
        caseId: ids[1],
        receivedAt: due('2025-01-01T09:00:00Z'),
        decisionDueBy: due('2025-01-08T09:00:00Z'),
      });
      const tieA = pended({
        caseId: ids[0],
        receivedAt: due('2025-01-01T09:00:00Z'),
        decisionDueBy: due('2025-01-08T09:00:00Z'),
      });
      const expedited = pended({
        receivedAt: due('2025-01-02T09:00:00Z'),
        decisionDueBy: due('2025-01-05T09:00:00Z'),
        priority: 'expedited',
      });
      const approved = automated({
        receivedAt: due('2024-12-01T09:00:00Z'),
        decisionDueBy: due('2024-12-08T09:00:00Z'),
      });
      for (const row of [tieB, standardEarly, approved, tieA, expedited]) await repo.enqueue(row);

      const queue = await repo.queue(10);
      expect(queue.map((row) => row.caseId)).toEqual([
        expedited.caseId,
        standardEarly.caseId,
        tieA.caseId,
        tieB.caseId,
      ]);
      expect((await repo.queue(2)).map((row) => row.caseId)).toEqual([
        expedited.caseId,
        standardEarly.caseId,
      ]);
    });

    it('matches by member, insurer and provider, and narrows by code', async () => {
      const member = `https://example.org/fhir/sid/member-id|SYN-${randomUUID()}`;
      const first = pended({ memberId: member, hcpcs: 'E0601' });
      const second = automated({
        memberId: member,
        hcpcs: 'E0470',
        receivedAt: new Date(first.receivedAt.getTime() + 1000),
        decisionDueBy: new Date(first.decisionDueBy.getTime() + 1000),
      });
      const otherProvider = pended({ memberId: member, providerId: 'synthetic|SUP-99' });
      for (const row of [second, first, otherProvider]) await repo.enqueue(row);

      const example = {
        memberId: member,
        insurerId: first.insurerId,
        providerId: first.providerId,
      };
      expect((await repo.match(example)).map((row) => row.caseId)).toEqual([
        first.caseId,
        second.caseId,
      ]);
      expect((await repo.match({ ...example, hcpcs: ['E0470'] })).map((r) => r.caseId)).toEqual([
        second.caseId,
      ]);
      expect(await repo.match({ ...example, memberId: `${member}-absent` })).toEqual([]);
    });

    it('decides a pended case once, replacing the response', async () => {
      const row = pended();
      await repo.enqueue(row);
      const decision = denial(row.caseId, 'sig-1');

      const result = await repo.decide(row.caseId, decision);
      expect(result.outcome).toBe('decided');

      const stored = await repo.get(row.caseId);
      expect(stored?.status).toBe('decided');
      expect(stored?.determination).toEqual(decision.determination);
      expect(stored?.reviewerId).toBe('synthetic-reviewer-001');
      expect(stored?.reviewerKeyId).toBe('synthetic-key-001');
      expect(stored?.signature).toBe('sig-1');
      expect(stored?.decidedAt?.toISOString()).toBe(decision.decidedAt.toISOString());
      expect(stored?.response).toEqual(decision.response);
      expect(await repo.queue(10)).toEqual([]);
    });

    it('answers a byte-identical retry with the stored row and a different decision with a conflict', async () => {
      const row = pended();
      await repo.enqueue(row);
      await repo.decide(row.caseId, denial(row.caseId, 'sig-1'));

      const retry = await repo.decide(row.caseId, {
        ...denial(row.caseId, 'sig-1'),
        response: { resourceType: 'Bundle', id: 'a-different-body' },
      });
      expect(retry.outcome).toBe('unchanged');
      if (retry.outcome !== 'not-found') {
        expect(retry.row.response).toEqual(denial(row.caseId, 'sig-1').response);
      }

      const second = await repo.decide(row.caseId, approval(row.caseId, 'sig-2'));
      expect(second.outcome).toBe('conflict');
      expect((await repo.get(row.caseId))?.signature).toBe('sig-1');
    });

    it('refuses to decide an automated approval, and reports an unknown case', async () => {
      const row = automated();
      await repo.enqueue(row);
      expect((await repo.decide(row.caseId, approval(row.caseId, 'sig-1'))).outcome).toBe(
        'conflict',
      );
      expect((await repo.get(row.caseId))?.status).toBe('approved-automated');
      expect((await repo.decide(randomUUID(), approval('x', 'sig-1'))).outcome).toBe('not-found');
    });

    it('leaves the case pended when beforeCommit throws', async () => {
      const row = pended();
      await repo.enqueue(row);
      await expect(
        repo.decide(row.caseId, denial(row.caseId, 'sig-1'), {
          beforeCommit: async () => {
            throw new Error('the ledger append failed');
          },
        }),
      ).rejects.toThrow('the ledger append failed');

      const stored = await repo.get(row.caseId);
      expect(stored?.status).toBe('pended');
      expect(stored?.signature).toBeNull();
      expect((await repo.decide(row.caseId, denial(row.caseId, 'sig-2'))).outcome).toBe('decided');
    });

    it('gives one of twenty concurrent decisions the case and nineteen a conflict', async () => {
      const row = pended();
      await repo.enqueue(row);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          repo.decide(row.caseId, denial(row.caseId, `sig-${i}`), {
            // Hold the lock across an await, as a ledger append would.
            beforeCommit: () => new Promise((resolve) => setTimeout(resolve, 5)),
          }),
        ),
      );
      const outcomes = results.map((result) => result.outcome);
      expect(outcomes.filter((outcome) => outcome === 'decided')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'conflict')).toHaveLength(19);

      const winner = results.findIndex((result) => result.outcome === 'decided');
      expect((await repo.get(row.caseId))?.signature).toBe(`sig-${winner}`);
    });

    it('flags an overdue pended case once and leaves it pended', async () => {
      const overdue = pended({
        receivedAt: new Date('2025-03-01T10:00:00Z'),
        decisionDueBy: new Date('2025-03-08T10:00:00Z'),
      });
      const notYet = pended({
        receivedAt: new Date('2025-03-02T10:00:00Z'),
        decisionDueBy: new Date('2025-03-09T10:00:00Z'),
      });
      const decided = pended({
        receivedAt: new Date('2025-03-01T09:00:00Z'),
        decisionDueBy: new Date('2025-03-08T09:00:00Z'),
      });
      for (const row of [overdue, notYet, decided]) await repo.enqueue(row);
      await repo.decide(decided.caseId, denial(decided.caseId, 'sig-1'));

      const now = new Date('2025-03-08T10:00:00Z');
      const first = await repo.flagOverdue(now);
      expect(first).toEqual([
        { caseId: overdue.caseId, priority: 'standard', decisionDueBy: overdue.decisionDueBy },
      ]);
      expect(await repo.flagOverdue(new Date('2025-03-08T11:00:00Z'))).toEqual([]);

      const stored = await repo.get(overdue.caseId);
      expect(stored?.status).toBe('pended');
      expect(stored?.overdueFlaggedAt?.toISOString()).toBe(now.toISOString());
      expect((await repo.get(notYet.caseId))?.overdueFlaggedAt).toBeNull();
    });
  });
}

const ATTESTATION = {
  reviewerId: 'synthetic-reviewer-001',
  credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
  attestedAt: '2026-10-08T12:00:00+00:00',
};

function base(overrides: Partial<NewCase>): NewCase {
  const receivedAt = overrides.receivedAt ?? new Date('2026-03-01T10:00:00Z');
  return {
    caseId: randomUUID(),
    status: 'pended',
    priority: 'standard',
    receivedAt,
    decisionDueBy: new Date(receivedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
    memberId: `https://example.org/fhir/sid/member-id|SYN-${randomUUID()}`,
    insurerId: 'https://example.org/fhir/sid/payer-id|QHP-SYN-001',
    providerId: 'https://example.org/fhir/sid/supplier-id|SUP-01',
    hcpcs: 'E0601',
    request: { resourceType: 'Bundle', type: 'collection' },
    disposition: {
      kind: 'refer-to-clinician',
      findings: [
        {
          criterionId: 'synthetic-criterion-1',
          status: 'insufficient',
          evidence: [],
          rationale: 'Synthetic fixture rationale.',
        },
      ],
    },
    response: { resourceType: 'Bundle', id: 'queued' },
    recommendationSeq: null,
    ...overrides,
  };
}

function pended(overrides: Partial<NewCase> = {}): NewCase {
  return base(overrides);
}

function automated(overrides: Partial<NewCase> = {}): NewCase {
  return base({
    status: 'approved-automated',
    disposition: { kind: 'automated-approval', criteriaMet: ['synthetic-criterion-1'] },
    response: { resourceType: 'Bundle', id: 'complete' },
    ...overrides,
  });
}

function denial(caseId: string, signature: string): Decision {
  return {
    determination: {
      kind: 'denial',
      specificReason: 'Synthetic fixture: synthetic-criterion-1 is not evidenced.',
      attestation: ATTESTATION,
    },
    reviewerId: ATTESTATION.reviewerId,
    reviewerKeyId: 'synthetic-key-001',
    signature,
    decidedAt: new Date('2026-03-03T10:00:00Z'),
    response: { resourceType: 'Bundle', id: `denied-${caseId}` },
  };
}

function approval(caseId: string, signature: string): Decision {
  return {
    ...denial(caseId, signature),
    determination: { kind: 'clinician-approval', attestation: ATTESTATION },
    response: { resourceType: 'Bundle', id: `approved-${caseId}` },
  };
}
