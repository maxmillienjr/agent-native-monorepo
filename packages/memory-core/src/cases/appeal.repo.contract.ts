import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdverseDeterminationRecord, ClinicianAttestation } from '@repo/determination';
import { attestReconsideration } from '@repo/determination/clinician';
import {
  caseFileDigest,
  caseFileOf,
  type AppealRepository,
  type Dismissal,
  type NewAppeal,
  type SignedAction,
} from './appeal.repo.js';
import type { CaseRepository, Decision, NewCase } from './case.repo.js';

/**
 * One contract, two stores (P3-F). `in-memory.appeal.repo.test.ts` runs it
 * against `InMemoryAppealRepository` under `test:unit`, and
 * `test/cases.integration.test.ts` against `DrizzleAppealRepository` on a
 * real Postgres under `test:integration`. `fresh` returns an empty pair of
 * stores, the appeal store built over the case store it references.
 *
 * Every fixture is synthetic (ADR 0003): the reviewers, the filer, the
 * credentials and the identifiers name no real person, board or payer.
 */
export function describeAppealRepositoryContract(
  name: string,
  fresh: () => Promise<{ cases: CaseRepository; appeals: AppealRepository }>,
): void {
  describe(`AppealRepository contract: ${name}`, () => {
    let cases: CaseRepository;
    let appeals: AppealRepository;
    beforeEach(async () => {
      ({ cases, appeals } = await fresh());
    });

    /** A case decided with a denial by the initial reviewer. */
    async function deniedCase(): Promise<string> {
      const row = pendedCase();
      await cases.enqueue(row);
      expect((await cases.decide(row.caseId, denialDecision(row.caseId))).outcome).toBe('decided');
      return row.caseId;
    }

    async function filed(overrides: Partial<NewAppeal> = {}): Promise<NewAppeal> {
      const appeal = newAppeal(overrides.caseId ?? (await deniedCase()), overrides);
      const result = await appeals.file(appeal);
      expect(result.outcome).toBe('filed');
      return appeal;
    }

    it('files an appeal on a denied case, naming the reviewer who denied it', async () => {
      const caseId = await deniedCase();
      const appeal = newAppeal(caseId, {
        request: {
          statement: 'Synthetic: the study was repeated.',
          evidence: { resourceType: 'Bundle', type: 'collection', entry: [] },
        },
      });
      const result = await appeals.file(appeal);
      expect(result.outcome).toBe('filed');

      const stored = await appeals.get(appeal.appealId);
      expect(stored).toMatchObject({
        appealId: appeal.appealId,
        caseId,
        initialReviewerId: INITIAL.reviewerId,
        status: 'filed',
        priority: 'standard',
        timely: true,
        reviewerId: null,
        forwardReason: null,
      });
      expect(stored?.reconsiderationDueBy.toISOString()).toBe(
        appeal.reconsiderationDueBy.toISOString(),
      );
      expect(stored?.filer).toEqual(appeal.filer);
      // The request is stored as received: key order survives the round trip.
      expect(JSON.stringify(stored?.request)).toBe(JSON.stringify(appeal.request));
    });

    it('refuses an automated approval, a clinician approval and a pended case, and reports an unknown one', async () => {
      const automated = automatedCase();
      await cases.enqueue(automated);
      const approved = pendedCase();
      await cases.enqueue(approved);
      await cases.decide(approved.caseId, approvalDecision(approved.caseId));
      const pended = pendedCase();
      await cases.enqueue(pended);

      for (const [caseId, status, determination] of [
        [automated.caseId, 'approved-automated', null],
        [approved.caseId, 'decided', 'clinician-approval'],
        [pended.caseId, 'pended', null],
      ] as const) {
        expect(await appeals.file(newAppeal(caseId))).toEqual({
          outcome: 'not-appealable',
          caseStatus: status,
          determination,
        });
      }
      expect((await appeals.file(newAppeal(randomUUID()))).outcome).toBe('not-found');
    });

    it('keeps one appeal open per case, and accepts a new one after a dismissal', async () => {
      const first = await filed();
      const second = await appeals.file(newAppeal(first.caseId));
      expect(second.outcome).toBe('already-open');
      if (second.outcome === 'already-open') expect(second.row.appealId).toBe(first.appealId);

      const dismissed = await appeals.dismiss(
        first.appealId,
        dismissal('withdrawn'),
        signedBy(OTHER),
      );
      expect(dismissed.outcome).toBe('recorded');
      const third = newAppeal(first.caseId);
      expect((await appeals.file(third)).outcome).toBe('filed');
    });

    it('queues filed appeals only, by deadline, then receipt, then appeal id', async () => {
      const ids = ['00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000ab'];
      const at = (iso: string) => new Date(iso);
      const tieB = await filed({ appealId: ids[1], receivedAt: at('2026-04-01T09:00:00Z') });
      const tieA = await filed({ appealId: ids[0], receivedAt: at('2026-04-01T09:00:00Z') });
      const early = await filed({ receivedAt: at('2026-04-01T08:00:00Z') });
      const expedited = await filed({
        receivedAt: at('2026-04-02T09:00:00Z'),
        priority: 'expedited',
        filer: { ...FILER, expedite: { requested: true, physicianSupport: false } },
      });
      const done = await filed({ receivedAt: at('2026-03-20T09:00:00Z') });
      await appeals.dismiss(done.appealId, dismissal('withdrawn'), signedBy(OTHER));

      expect((await appeals.queue(10)).map((row) => row.appealId)).toEqual([
        expedited.appealId,
        early.appealId,
        tieA.appealId,
        tieB.appealId,
      ]);
      expect((await appeals.queue(1)).map((row) => row.appealId)).toEqual([expedited.appealId]);
    });

    it('reverses: the case response becomes the reversal, and the initial denial is untouched', async () => {
      const appeal = await filed();
      const before = await cases.get(appeal.caseId);
      const response = { resourceType: 'Bundle', id: `reversed-${appeal.caseId}` };

      const result = await appeals.reconsider(
        appeal.appealId,
        reconsideration('reversal'),
        signedBy(OTHER, 'sig-r'),
        { response },
      );
      expect(result.outcome).toBe('recorded');

      const stored = await appeals.get(appeal.appealId);
      expect(stored).toMatchObject({
        status: 'reversed',
        reviewerId: OTHER.reviewerId,
        reviewerKeyId: 'synthetic-key-002',
        signature: 'sig-r',
        forwardReason: null,
        caseFileDigest: null,
      });
      expect(stored?.reconsideration?.kind).toBe('reversal');

      const after = await cases.get(appeal.caseId);
      expect(after?.response).toEqual(response);
      expect(after?.determination).toEqual(before?.determination);
      expect(after?.reviewerId).toBe(INITIAL.reviewerId);
      expect(after?.signature).toBe(before?.signature);
      expect(await appeals.queue(10)).toEqual([]);
    });

    it('affirms and forwards in the same write, with a digest of the case file', async () => {
      const appeal = await filed();
      const before = await cases.get(appeal.caseId);
      const signed = signedBy(OTHER, 'sig-a');
      const result = await appeals.reconsider(
        appeal.appealId,
        reconsideration('affirmation'),
        signed,
      );
      expect(result.outcome).toBe('recorded');

      const stored = await appeals.get(appeal.appealId);
      const caseRow = await cases.get(appeal.caseId);
      if (stored === null || caseRow === null) throw new Error('missing row');
      expect(stored.status).toBe('forwarded');
      expect(stored.forwardReason).toBe('affirmed');
      expect(stored.forwardedAt?.toISOString()).toBe(signed.decidedAt.toISOString());
      expect(stored.decidedAt?.toISOString()).toBe(signed.decidedAt.toISOString());
      expect(stored.caseFileDigest).toBe(caseFileDigest(caseFileOf(stored, caseRow)));
      expect(caseFileOf(stored, caseRow)['forward']).toMatchObject({
        reason: 'affirmed',
        explanation: reconsideration('affirmation').explanation,
      });
      // The denial stays in force until the independent entity rules.
      expect(caseRow.response).toEqual(before?.response);
    });

    it('dismisses, recording the reason and who dismissed', async () => {
      const appeal = await filed();
      const result = await appeals.dismiss(
        appeal.appealId,
        dismissal('not-a-proper-party'),
        signedBy(OTHER, 'sig-d'),
      );
      expect(result.outcome).toBe('recorded');
      expect(await appeals.get(appeal.appealId)).toMatchObject({
        status: 'dismissed',
        dismissalReason: 'not-a-proper-party',
        reviewerId: OTHER.reviewerId,
        signature: 'sig-d',
        reconsideration: null,
      });
    });

    it('answers a byte-identical retry unchanged and a different action with a conflict', async () => {
      const appeal = await filed();
      const response = { resourceType: 'Bundle', id: 'reversed' };
      await appeals.reconsider(
        appeal.appealId,
        reconsideration('reversal'),
        signedBy(OTHER, 'sig-1'),
        {
          response,
        },
      );

      const retry = await appeals.reconsider(
        appeal.appealId,
        reconsideration('reversal'),
        { ...signedBy(OTHER, 'sig-1'), decidedAt: new Date('2026-04-03T10:00:00Z') },
        { response: { resourceType: 'Bundle', id: 'a-different-body' } },
      );
      expect(retry.outcome).toBe('unchanged');
      if (retry.outcome !== 'not-found') expect(retry.caseRow.response).toEqual(response);

      const affirm = await appeals.reconsider(
        appeal.appealId,
        reconsideration('affirmation'),
        signedBy(OTHER, 'sig-2'),
      );
      expect(affirm.outcome).toBe('conflict');
      const dismiss = await appeals.dismiss(
        appeal.appealId,
        dismissal('withdrawn'),
        signedBy(OTHER, 'sig-3'),
      );
      expect(dismiss.outcome).toBe('conflict');
      expect((await appeals.get(appeal.appealId))?.signature).toBe('sig-1');
      expect(
        (
          await appeals.reconsider(randomUUID(), reconsideration('reversal'), signedBy(OTHER), {
            response,
          })
        ).outcome,
      ).toBe('not-found');
    });

    it('forwards a lapsed appeal when an action arrives after the deadline, and records nothing else', async () => {
      const appeal = await filed();
      const late = { ...signedBy(OTHER, 'sig-late'), decidedAt: appeal.reconsiderationDueBy };
      const result = await appeals.reconsider(appeal.appealId, reconsideration('reversal'), late, {
        response: { resourceType: 'Bundle', id: 'too-late' },
      });
      expect(result.outcome).toBe('lapsed');

      const stored = await appeals.get(appeal.appealId);
      expect(stored).toMatchObject({
        status: 'forwarded',
        forwardReason: 'deadline-lapsed',
        reconsideration: null,
        reviewerId: null,
        signature: null,
      });
      expect(stored?.forwardedAt?.toISOString()).toBe(appeal.reconsiderationDueBy.toISOString());
      expect((await cases.get(appeal.caseId))?.response).not.toEqual({
        resourceType: 'Bundle',
        id: 'too-late',
      });
    });

    it('forwards each lapsed appeal once, and leaves one not yet due', async () => {
      const lapsed = await filed({
        receivedAt: new Date('2026-04-01T10:00:00Z'),
        priority: 'expedited',
        filer: { ...FILER, expedite: { requested: true, physicianSupport: true } },
      });
      const notYet = await filed({ receivedAt: new Date('2026-04-01T10:00:00Z') });
      const now = new Date('2026-04-04T10:00:00Z');

      const first = await appeals.forwardLapsed(now);
      expect(first.map((row) => row.appealId)).toEqual([lapsed.appealId]);
      expect(first[0]?.forwardedAt.toISOString()).toBe(now.toISOString());
      expect(await appeals.forwardLapsed(new Date('2026-04-04T11:00:00Z'))).toEqual([]);

      const stored = await appeals.get(lapsed.appealId);
      const caseRow = await cases.get(lapsed.caseId);
      if (stored === null || caseRow === null) throw new Error('missing row');
      expect(stored.forwardReason).toBe('deadline-lapsed');
      expect(stored.caseFileDigest).toBe(first[0]?.caseFileDigest);
      expect(stored.caseFileDigest).toBe(caseFileDigest(caseFileOf(stored, caseRow)));
      expect(caseFileOf(stored, caseRow)['forward']).toMatchObject({
        explanation: expect.stringContaining('§ 422.590(g)'),
      });
      expect((await appeals.get(notYet.appealId))?.status).toBe('filed');
    });

    it('leaves the appeal filed and the case as it was when beforeCommit throws', async () => {
      const appeal = await filed();
      const before = await cases.get(appeal.caseId);
      await expect(
        appeals.reconsider(appeal.appealId, reconsideration('reversal'), signedBy(OTHER), {
          response: { resourceType: 'Bundle', id: 'not-written' },
          beforeCommit: async () => {
            throw new Error('the ledger append failed');
          },
        }),
      ).rejects.toThrow('the ledger append failed');
      expect((await appeals.get(appeal.appealId))?.status).toBe('filed');
      expect((await cases.get(appeal.caseId))?.response).toEqual(before?.response);

      const caseId = await deniedCase();
      await expect(
        appeals.file(newAppeal(caseId), {
          beforeCommit: async () => {
            throw new Error('the ledger append failed');
          },
        }),
      ).rejects.toThrow('the ledger append failed');
      expect((await appeals.file(newAppeal(caseId))).outcome).toBe('filed');
    });

    it('hands beforeCommit the row about to be written, a forward with its digest, and writes nothing when it throws', async () => {
      const affirmed = await filed();
      const seen: { status: string; digest: string | null }[] = [];
      await appeals.reconsider(affirmed.appealId, reconsideration('affirmation'), signedBy(OTHER), {
        beforeCommit: async (next) => {
          seen.push({ status: next.status, digest: next.caseFileDigest });
        },
      });
      const stored = await appeals.get(affirmed.appealId);
      expect(seen).toEqual([{ status: 'forwarded', digest: stored?.caseFileDigest }]);

      const lapsing = await filed({ receivedAt: new Date('2026-04-01T10:00:00Z') });
      const now = new Date('2026-05-01T10:00:00Z');
      const failing = {
        beforeCommit: async () => {
          throw new Error('the ledger append failed');
        },
      };
      await expect(appeals.forwardLapsed(now, failing)).rejects.toThrow('the ledger append failed');
      expect((await appeals.get(lapsing.appealId))?.status).toBe('filed');
      await expect(
        appeals.dismiss(
          lapsing.appealId,
          dismissal('withdrawn'),
          { ...signedBy(OTHER), decidedAt: now },
          failing,
        ),
      ).rejects.toThrow('the ledger append failed');
      expect((await appeals.get(lapsing.appealId))?.status).toBe('filed');

      const lapses: string[] = [];
      const forwarded = await appeals.forwardLapsed(now, {
        beforeCommit: async (next) => {
          lapses.push(`${next.appealId} ${next.forwardReason}`);
        },
      });
      expect(forwarded.map((row) => row.appealId)).toEqual([lapsing.appealId]);
      expect(lapses).toEqual([`${lapsing.appealId} deadline-lapsed`]);
    });

    it('refuses, in the store, a dismissal by the reviewer who denied', async () => {
      const appeal = await filed();
      const own: Dismissal = { ...dismissal('withdrawn'), attestation: INITIAL };
      await expect(appeals.dismiss(appeal.appealId, own, signedBy(INITIAL))).rejects.toThrow(
        /made the determination/,
      );
      expect((await appeals.get(appeal.appealId))?.status).toBe('filed');
    });

    it('gives one of twenty concurrent reconsiderations the appeal and nineteen a conflict', async () => {
      const appeal = await filed();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          appeals.reconsider(
            appeal.appealId,
            reconsideration(i % 2 === 0 ? 'reversal' : 'affirmation'),
            signedBy(OTHER, `sig-${i}`),
            {
              ...(i % 2 === 0 ? { response: { resourceType: 'Bundle', id: `r-${i}` } } : {}),
              // Hold the lock across an await, as a ledger append would.
              beforeCommit: () => new Promise((resolve) => setTimeout(resolve, 5)),
            },
          ),
        ),
      );
      const outcomes = results.map((result) => result.outcome);
      expect(outcomes.filter((outcome) => outcome === 'recorded')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'conflict')).toHaveLength(19);
      const winner = results.findIndex((result) => result.outcome === 'recorded');
      expect((await appeals.get(appeal.appealId))?.signature).toBe(`sig-${winner}`);
    });
  });
}

const INITIAL: ClinicianAttestation = {
  reviewerId: 'synthetic-reviewer-001',
  credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
  attestedAt: '2026-03-03T10:00:00+00:00',
};

const OTHER: ClinicianAttestation = {
  reviewerId: 'synthetic-reviewer-002',
  credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
  attestedAt: '2026-04-02T10:00:00+00:00',
};

const DENIAL: AdverseDeterminationRecord = {
  kind: 'denial',
  specificReason: 'Synthetic fixture: synthetic-criterion-1 is not evidenced.',
  attestation: INITIAL,
};

const FILER = {
  role: 'enrollee' as const,
  name: 'Synthetic Enrollee',
  channel: 'written' as const,
  expedite: { requested: false, physicianSupport: false },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function pendedCase(): NewCase {
  const receivedAt = new Date('2026-03-01T10:00:00Z');
  return {
    caseId: randomUUID(),
    status: 'pended',
    priority: 'standard',
    receivedAt,
    decisionDueBy: new Date(receivedAt.getTime() + 7 * DAY_MS),
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
  };
}

function automatedCase(): NewCase {
  return {
    ...pendedCase(),
    status: 'approved-automated',
    disposition: { kind: 'automated-approval', criteriaMet: ['synthetic-criterion-1'] },
    response: { resourceType: 'Bundle', id: 'complete' },
  };
}

function denialDecision(caseId: string): Decision {
  return {
    determination: DENIAL,
    reviewerId: INITIAL.reviewerId,
    reviewerKeyId: 'synthetic-key-001',
    signature: `sig-denial-${caseId}`,
    decidedAt: new Date('2026-03-03T10:00:00Z'),
    response: { resourceType: 'Bundle', id: `denied-${caseId}` },
  };
}

function approvalDecision(caseId: string): Decision {
  return {
    ...denialDecision(caseId),
    determination: { kind: 'clinician-approval', attestation: INITIAL },
    response: { resourceType: 'Bundle', id: `approved-${caseId}` },
  };
}

/** A timely standard filing, received a month after the denial. */
function newAppeal(caseId: string, overrides: Partial<NewAppeal> = {}): NewAppeal {
  const receivedAt = overrides.receivedAt ?? new Date('2026-04-01T10:00:00Z');
  const priority = overrides.priority ?? 'standard';
  return {
    appealId: randomUUID(),
    caseId,
    priority,
    filer: FILER,
    receivedAt,
    filingDeadline: new Date('2026-05-07T23:59:59.999Z'),
    timely: true,
    reconsiderationDueBy: new Date(
      receivedAt.getTime() + (priority === 'expedited' ? 3 : 30) * DAY_MS,
    ),
    request: { statement: 'Synthetic: the enrollee asks the plan to look again.' },
    ...overrides,
  };
}

function reconsideration(kind: 'reversal' | 'affirmation') {
  return attestReconsideration(
    DENIAL,
    {
      kind,
      explanation: `Synthetic fixture: ${kind} on reconsideration.`,
      goodCauseFound: false,
    },
    OTHER,
  );
}

function dismissal(reason: Dismissal['reason']): Dismissal {
  return { reason, explanation: `Synthetic fixture: dismissed as ${reason}.`, attestation: OTHER };
}

function signedBy(by: ClinicianAttestation, signature = 'sig-x'): SignedAction {
  return {
    reviewerId: by.reviewerId,
    reviewerKeyId: by === INITIAL ? 'synthetic-key-001' : 'synthetic-key-002',
    signature,
    decidedAt: new Date('2026-04-02T10:00:00Z'),
  };
}
