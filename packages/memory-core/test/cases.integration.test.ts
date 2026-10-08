import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import pg from 'pg';
import { DrizzleCaseRepository } from '../src/cases/case.repo.js';
import { describeCaseRepositoryContract } from '../src/cases/case.repo.contract.js';
import { priorAuthCases } from '../src/cases/schema.js';
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

  // The memory-live half of the contract `in-memory.repo.test.ts` runs in
  // process. Each test starts from an empty table.
  describeCaseRepositoryContract('DrizzleCaseRepository', async () => {
    await db.delete(priorAuthCases);
    return new DrizzleCaseRepository(db);
  });

  it('creates exactly the columns the Drizzle declaration queries', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'prior_auth_cases' ORDER BY ordinal_position`,
    );
    const declared = Object.values(getTableColumns(priorAuthCases)).map((column) => column.name);
    expect(rows.map((row) => row.column_name)).toEqual(declared);
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
    await db.delete(priorAuthCases);
  });
});
