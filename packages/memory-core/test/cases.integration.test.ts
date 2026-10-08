import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import pg from 'pg';
import { DrizzleAppealRepository } from '../src/cases/appeal.repo.js';
import { describeAppealRepositoryContract } from '../src/cases/appeal.repo.contract.js';
import { DrizzleCaseRepository } from '../src/cases/case.repo.js';
import { describeCaseRepositoryContract } from '../src/cases/case.repo.contract.js';
import { priorAuthAppeals, priorAuthCases } from '../src/cases/schema.js';
import { runMigrations } from '../src/migrate.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const SKIP = skipUnlessIntegrationEnv('DrizzleCaseRepository (integration)', 'DATABASE_URL');

describe.skipIf(SKIP)('DrizzleCaseRepository (integration)', () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool);
    // The migration is the only DDL for this table.
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Empties both tables, appeals first: an appeal references its case. */
  async function empty(): Promise<void> {
    await db.delete(priorAuthAppeals);
    await db.delete(priorAuthCases);
  }

  // The memory-live half of the contract `in-memory.repo.test.ts` runs in
  // process. Each test starts from an empty table.
  describeCaseRepositoryContract('DrizzleCaseRepository', async () => {
    await empty();
    return new DrizzleCaseRepository(db);
  });

  // And of the appeal contract `in-memory.appeal.repo.test.ts` runs (P3-F).
  describeAppealRepositoryContract('DrizzleAppealRepository', async () => {
    await empty();
    return { cases: new DrizzleCaseRepository(db), appeals: new DrizzleAppealRepository(db) };
  });

  it('creates exactly the columns the Drizzle declarations query', async () => {
    for (const [name, table] of [
      ['prior_auth_cases', priorAuthCases],
      ['prior_auth_appeals', priorAuthAppeals],
    ] as const) {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = $1 ORDER BY ordinal_position`,
        [name],
      );
      const declared = Object.values(getTableColumns(table)).map((column) => column.name);
      expect(rows.map((row) => row.column_name)).toEqual(declared);
    }
  });

  // P3-F: § 422.590(h)(1) as constraints, each probed by raw SQL past the
  // repository, which is what a person holding the service's credentials
  // could run.
  describe('the non-involvement rule, held by Postgres whatever writes the row', () => {
    const INITIAL = 'synthetic-reviewer-001';
    const OTHER = 'synthetic-reviewer-002';
    const attestedBy = (reviewerId: string) => ({
      reviewerId,
      credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
      attestedAt: '2026-04-02T10:00:00+00:00',
    });
    const reversalBy = (reviewerId: string) =>
      JSON.stringify({
        kind: 'reversal',
        explanation: 'Synthetic: reversed on reconsideration.',
        goodCauseFound: false,
        attestation: attestedBy(reviewerId),
        initialReviewerId: INITIAL,
      });

    /** A case pended, or decided with a denial by the initial reviewer. */
    async function caseRow(decided: boolean): Promise<string> {
      const cases = new DrizzleCaseRepository(db);
      const caseId = randomUUID();
      await cases.enqueue({
        caseId,
        status: 'pended',
        priority: 'standard',
        receivedAt: new Date('2026-03-01T10:00:00Z'),
        decisionDueBy: new Date('2026-03-08T10:00:00Z'),
        memberId: `https://example.org/fhir/sid/member-id|SYN-${caseId}`,
        insurerId: 'https://example.org/fhir/sid/payer-id|QHP-SYN-001',
        providerId: 'https://example.org/fhir/sid/supplier-id|SUP-01',
        hcpcs: 'E0601',
        request: { resourceType: 'Bundle', type: 'collection' },
        disposition: { kind: 'refer-to-clinician', findings: [] },
        response: { resourceType: 'Bundle', id: 'queued' },
        recommendationSeq: null,
      });
      if (decided) {
        await cases.decide(caseId, {
          determination: {
            kind: 'denial',
            specificReason: 'Synthetic: not evidenced.',
            attestation: attestedBy(INITIAL),
          },
          reviewerId: INITIAL,
          reviewerKeyId: 'synthetic-key-001',
          signature: 'sig-denial',
          decidedAt: new Date('2026-03-03T10:00:00Z'),
          response: { resourceType: 'Bundle', id: 'denied' },
        });
      }
      return caseId;
    }

    /** A filed appeal, inserted by raw SQL naming `initialReviewer`. */
    const insertAppeal = (caseId: string, initialReviewer: string, appealId = randomUUID()) =>
      pool.query(
        `INSERT INTO prior_auth_appeals (appeal_id, case_id, initial_reviewer_id, status, priority,
           filer, received_at, filing_deadline, timely, reconsideration_due_by, request)
         VALUES ($1, $2, $3, 'filed', 'standard', $4::jsonb, '2026-04-01T10:00:00Z',
           '2026-05-07T23:59:59.999Z', true, '2026-05-01T10:00:00Z', $5::json)`,
        [
          appealId,
          caseId,
          initialReviewer,
          JSON.stringify({
            role: 'enrollee',
            name: 'Synthetic Enrollee',
            channel: 'written',
            expedite: { requested: false, physicianSupport: false },
          }),
          JSON.stringify({ statement: 'Synthetic: please look again.' }),
        ],
      );

    /** Sets a filed appeal to a complete reversal signed by `reviewerId`. */
    const reverseAs = (appealId: string, reviewerId: string) =>
      pool.query(
        `UPDATE prior_auth_appeals SET status = 'reversed', reviewer_id = $2,
           reviewer_key_id = 'synthetic-key-x', signature = 'sig-x', decided_at = now(),
           reconsideration = $3::jsonb
         WHERE appeal_id = $1`,
        [appealId, reviewerId, reversalBy(reviewerId)],
      );

    it("inserts an appeal naming the case's reviewer, and refuses one naming another", async () => {
      const caseId = await caseRow(true);
      await expect(insertAppeal(caseId, OTHER)).rejects.toThrow(/prior_auth_appeals_initial/);
      await insertAppeal(caseId, INITIAL);
    });

    it('refuses an appeal on a pended case, which has no reviewer to name', async () => {
      const caseId = await caseRow(false);
      await expect(insertAppeal(caseId, INITIAL)).rejects.toThrow(/prior_auth_appeals_initial/);
    });

    it('refuses an update setting the reviewer to the initial one, and takes another', async () => {
      const caseId = await caseRow(true);
      const appealId = randomUUID();
      await insertAppeal(caseId, INITIAL, appealId);
      // A complete reversal in every other respect, so this is the one rule it breaks.
      await expect(reverseAs(appealId, INITIAL)).rejects.toThrow(/prior_auth_appeals_not_involved/);
      await reverseAs(appealId, OTHER);
      expect((await new DrizzleAppealRepository(db).get(appealId))?.status).toBe('reversed');
    });

    it("refuses rewriting the case's reviewer while an appeal names it", async () => {
      const caseId = await caseRow(true);
      await insertAppeal(caseId, INITIAL);
      await expect(
        pool.query(`UPDATE prior_auth_cases SET reviewer_id = $2 WHERE case_id = $1`, [
          caseId,
          OTHER,
        ]),
      ).rejects.toThrow(/prior_auth_appeals_initial/);
    });

    it('refuses a forward with no case file, and a reviewer in the record that is not the column', async () => {
      const caseId = await caseRow(true);
      const appealId = randomUUID();
      await insertAppeal(caseId, INITIAL, appealId);
      await expect(
        pool.query(
          `UPDATE prior_auth_appeals SET status = 'forwarded', forward_reason = 'deadline-lapsed',
             forwarded_at = now() WHERE appeal_id = $1`,
          [appealId],
        ),
      ).rejects.toThrow(/prior_auth_appeals_state/);
      await expect(
        pool.query(
          `UPDATE prior_auth_appeals SET status = 'reversed', reviewer_id = $2,
             reviewer_key_id = 'synthetic-key-x', signature = 'sig-x', decided_at = now(),
             reconsideration = $3::jsonb
           WHERE appeal_id = $1`,
          [appealId, OTHER, reversalBy('synthetic-reviewer-003')],
        ),
      ).rejects.toThrow(/prior_auth_appeals_signed_record/);
    });
  });

  it('makes get throw on a row whose disposition was edited to a denial', async () => {
    const repo = new DrizzleCaseRepository(db);
    const caseId = randomUUID();
    await repo.enqueue({
      caseId,
      status: 'pended',
      priority: 'standard',
      receivedAt: new Date('2026-03-01T10:00:00Z'),
      decisionDueBy: new Date('2026-03-08T10:00:00Z'),
      memberId: 'https://example.org/fhir/sid/member-id|SYN-EDITED',
      insurerId: 'https://example.org/fhir/sid/payer-id|QHP-SYN-001',
      providerId: 'https://example.org/fhir/sid/supplier-id|SUP-01',
      hcpcs: 'E0601',
      request: { resourceType: 'Bundle', type: 'collection' },
      disposition: { kind: 'refer-to-clinician', findings: [] },
      response: { resourceType: 'Bundle', id: 'queued' },
      recommendationSeq: null,
    });
    expect((await repo.get(caseId))?.status).toBe('pended');

    // What a person with the service's credentials could do, outside the
    // repository: rewrite the agent's referral as a denial.
    await pool.query(`UPDATE prior_auth_cases SET disposition = $1::jsonb WHERE case_id = $2`, [
      JSON.stringify({
        kind: 'denial',
        specificReason: 'Synthetic: forged in place.',
        attestation: {
          reviewerId: 'synthetic-reviewer-001',
          credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
          attestedAt: '2026-10-08T12:00:00+00:00',
        },
      }),
      caseId,
    ]);

    await expect(repo.get(caseId)).rejects.toThrow(/refer-to-clinician|automated-approval/);
    await expect(repo.queue(500)).rejects.toThrow();
  });

  it('refuses a half-decided row at the database, whatever wrote it', async () => {
    const repo = new DrizzleCaseRepository(db);
    const caseId = randomUUID();
    await repo.enqueue({
      caseId,
      status: 'pended',
      priority: 'expedited',
      receivedAt: new Date('2026-03-01T10:00:00Z'),
      decisionDueBy: new Date('2026-03-04T10:00:00Z'),
      memberId: 'https://example.org/fhir/sid/member-id|SYN-CHECK',
      insurerId: 'https://example.org/fhir/sid/payer-id|QHP-SYN-001',
      providerId: 'https://example.org/fhir/sid/supplier-id|SUP-01',
      hcpcs: 'E0601',
      request: { resourceType: 'Bundle', type: 'collection' },
      disposition: { kind: 'refer-to-clinician', findings: [] },
      response: { resourceType: 'Bundle', id: 'queued' },
      recommendationSeq: null,
    });
    await expect(
      pool.query(`UPDATE prior_auth_cases SET status = 'decided' WHERE case_id = $1`, [caseId]),
    ).rejects.toThrow(/prior_auth_cases_decided/);
    await empty();
  });
});
