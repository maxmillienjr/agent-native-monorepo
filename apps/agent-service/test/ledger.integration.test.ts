import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type pg from 'pg';
import {
  Ledger,
  PgLedgerStore,
  attestationBytes,
  commitmentOf,
  createLedgerPool,
  entryHashOf,
  payloadText,
  runLedgerMigrations,
  uuidV5,
  type LedgerPayload,
} from '@repo/decision-ledger';
import { startTestTsa, type TestTsa } from '@repo/decision-ledger/testing';
import { MEMORY_RECALL_DATASET_DIR, loadMemoryRecallSuite } from '@repo/eval-harness';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { PG_POOL } from '../src/memory/memory.tokens.js';
import { createAgentServiceHarness } from '../src/eval/agent-harness.js';
import { replayDecks, watchForModelRequests } from '../src/eval/cassette-deps.js';
import { generateReviewerKey, signDetermination } from '../src/review/signer.js';
import { skipUnlessIntegrationEnv } from './integration-env.js';

const BUNDLES = join(
  import.meta.dirname,
  '../../../packages/eval-harness/datasets/prior-auth/bundles',
);

/** A synthetic reviewer, generated for this run and never written outside a temp dir. */
const PHYSICIAN = generateReviewerKey({
  reviewerKeyId: 'synthetic-ledger-key-001',
  reviewerId: 'synthetic-ledger-reviewer-001',
  credential: { type: 'synthetic-physician', jurisdiction: 'US-SYNTHETIC' },
});

/**
 * The decision ledger in the service, against live Postgres and Neo4j (P3-C).
 * Model `stub` unless a test says otherwise; memory `live`; the ledger in a
 * database of its own, written as `ledger_writer`.
 *
 * The edits are made as a superuser in replica mode, which is the threat
 * model's database administrator: the one actor the database cannot stop, and
 * the one the verifier and the anchors exist for. Every `ledger:verify` and
 * `ledger:anchor` here is the compiled command.
 */

const SKIP = skipUnlessIntegrationEnv('decision ledger (integration)', 'DATABASE_URL', 'NEO4J_URI');

const SESSION = '550e8400-e29b-41d4-a716-4466554400c3';
const BODY = { sessionId: SESSION, messages: [{ role: 'user', content: 'What is LangGraph?' }] };
const execFileAsync = promisify(execFile);
const DIST = join(import.meta.dirname, '..', 'dist', 'ledger');

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(DIST, script), ...args],
      {
        env: { ...process.env, ...env },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

/** A ledger database of its own, migrated by the superuser, written as `ledger_writer`. */
interface LedgerDb {
  readonly name: string;
  readonly owner: pg.Pool;
  readonly writer: pg.Pool;
  readonly writerUrl: string;
  readonly ledger: Ledger;
  drop(): Promise<void>;
}

async function createLedgerDb(admin: pg.Pool): Promise<LedgerDb> {
  const name = `ledger_svc_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);

  const ownerUrl = new URL(process.env['DATABASE_URL']!);
  ownerUrl.pathname = `/${name}`;
  const owner = createLedgerPool(ownerUrl.toString());
  await runLedgerMigrations(owner);
  // A login of its own, granted ledger_writer, as a deployment would issue one:
  // suites running at once never reset each other's password.
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' IN ROLE ledger_writer`);

  const writerUrl = new URL(ownerUrl);
  writerUrl.username = name;
  writerUrl.password = password;
  const writer = createLedgerPool(writerUrl.toString());

  return {
    name,
    owner,
    writer,
    writerUrl: writerUrl.toString(),
    ledger: new Ledger(new PgLedgerStore(writer)),
    drop: async () => {
      await writer.end();
      await owner.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    },
  };
}

/** Runs `work` as a superuser in replica mode, where no trigger and no foreign key fires. */
async function asDba(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const runPayload = (runId: string): LedgerPayload => ({
  kind: 'run.recorded',
  runId,
  gitSha: null,
  outcome: 'success',
  decisionCount: 1,
  checkpointCount: 1,
  runDigest: 'ab'.repeat(32),
});

/**
 * Appends an entry as the owner would with the table to itself: hashed and
 * linked correctly, with none of the rules `append` applies. How a forged
 * attestation gets into a chain.
 */
async function forge(db: LedgerDb, payload: LedgerPayload): Promise<number> {
  const rows = await db.ledger.readRows();
  const head = rows.entries.at(-1);
  const salt = randomBytes(16);
  const text = payloadText(payload);
  const fields = {
    seq: head === undefined ? 0 : head.seq + 1,
    entryId: randomUUID(),
    kind: payload.kind,
    recordedAt: new Date().toISOString(),
    prevHash: head === undefined ? '0'.repeat(64) : head.entryHash,
    commitment: commitmentOf(salt, text),
  };
  await db.owner.query(
    `INSERT INTO ledger_entries (seq, entry_id, kind, recorded_at, prev_hash, commitment, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      fields.seq,
      fields.entryId,
      fields.kind,
      fields.recordedAt,
      Buffer.from(fields.prevHash, 'hex'),
      Buffer.from(fields.commitment, 'hex'),
      Buffer.from(entryHashOf(fields), 'hex'),
    ],
  );
  await db.owner.query(
    'INSERT INTO ledger_payloads (entry_id, salt, payload) VALUES ($1, $2, $3)',
    [fields.entryId, salt, text],
  );
  return fields.seq;
}

/** A synthetic reviewer key, generated in-test and never written anywhere. */
function syntheticReviewer(n: number) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  const id = String(n).padStart(3, '0');
  return {
    registration: {
      kind: 'reviewer-key.registered',
      reviewerKeyId: `synthetic-key-${id}`,
      reviewerId: `synthetic-reviewer-${id}`,
      credential: { type: 'MD', jurisdiction: 'US-SYNTHETIC' },
      publicKey: x,
    } satisfies LedgerPayload,
    attest(runId: string, recommendationSeq: number): LedgerPayload {
      const determination = {
        kind: 'denial' as const,
        specificReason: 'Synthetic fixture: the record does not document the criterion.',
        attestation: {
          reviewerId: `synthetic-reviewer-${id}`,
          credential: { type: 'MD', jurisdiction: 'US-SYNTHETIC' },
          attestedAt: '2026-10-08T12:00:00.000Z',
        },
      };
      const bytes = attestationBytes({ determination, recommendationSeq, runId });
      return {
        kind: 'determination.attested',
        runId,
        recommendationSeq,
        determination,
        reviewerKeyId: `synthetic-key-${id}`,
        signature: sign(null, bytes, privateKey).toString('base64url'),
      };
    },
  };
}

describe.skipIf(SKIP)('decision ledger (integration)', () => {
  let admin: pg.Pool;
  let service: LedgerDb;
  let app: NestExpressApplication;
  let pool: pg.Pool;
  let tsa: TestTsa;
  let savedKey: string | undefined;
  let env: Record<string, string>;

  beforeAll(async () => {
    savedKey = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];

    admin = createLedgerPool(process.env['DATABASE_URL']!);
    service = await createLedgerDb(admin);
    tsa = await startTestTsa();
    process.env['LEDGER_DATABASE_URL'] = service.writerUrl;
    env = { LEDGER_DATABASE_URL: service.writerUrl, LEDGER_TSA_CA: tsa.caFile };
    const registry = join(
      mkdtempSync(join(tmpdir(), 'synthetic-ledger-registry-')),
      'registry.json',
    );
    writeFileSync(registry, JSON.stringify([PHYSICIAN.entry]));
    process.env['REVIEWER_REGISTRY'] = registry;

    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    pool = app.get<pg.Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app?.close();
    delete process.env['LEDGER_DATABASE_URL'];
    delete process.env['REVIEWER_REGISTRY'];
    await tsa?.close();
    await service?.drop();
    await admin?.end();
    if (savedKey !== undefined) process.env['GOOGLE_API_KEY'] = savedKey;
  });

  async function post(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/runs')
      .set('Content-Type', 'application/json')
      .set('x-correlation-id', `ledger-${Date.now()}`)
      .send(BODY);
    expect(response.status).toBe(200);
    return (response.body as { runId: string }).runId;
  }

  async function entriesFor(runId: string): Promise<{ seq: number; kind: string }[]> {
    const rows = await service.ledger.readRows();
    const ids = new Set(
      rows.payloads
        .filter((row) => (JSON.parse(row.payload) as { runId?: string }).runId === runId)
        .map((row) => row.entryId),
    );
    return rows.entries
      .filter((entry) => ids.has(entry.entryId))
      .map((entry) => ({ seq: entry.seq, kind: entry.kind }));
  }

  /** Edits a store row, runs `ledger:verify`, and puts the row back. */
  async function verifyWhileEdited(edit: () => Promise<() => Promise<void>>): Promise<CliResult> {
    const restore = await edit();
    try {
      return await cli('verify.js', [], env);
    } finally {
      await restore();
    }
  }

  describe('run.recorded', () => {
    it('commits one entry per POST /runs, whose digest ledger:verify re-derives', async () => {
      const runId = await post();

      expect(await entriesFor(runId)).toEqual([{ seq: expect.any(Number), kind: 'run.recorded' }]);
      const verified = await cli('verify.js', [], env);
      expect(verified.code).toBe(0);
      expect(verified.stdout).toContain('VERIFIED (exit 0)');
      expect(verified.stdout).toMatch(/runs: (\d+) of \1 committed digests re-derived/);
    });

    it('exits 1 naming the run when one of its checkpoint blobs is edited', async () => {
      const runId = await post();

      const result = await verifyWhileEdited(async () => {
        const saved = await pool.query<{ blob: Buffer }>(
          `SELECT blob FROM checkpoint_blobs WHERE thread_id = $1 AND channel = 'currentPlan'`,
          [runId],
        );
        await pool.query(
          `UPDATE checkpoint_blobs SET blob = convert_to('"an edited plan"', 'UTF8')
           WHERE thread_id = $1 AND channel = 'currentPlan'`,
          [runId],
        );
        return async () => {
          await pool.query(
            `UPDATE checkpoint_blobs SET blob = $2 WHERE thread_id = $1 AND channel = 'currentPlan'`,
            [runId, saved.rows[0]!.blob],
          );
        };
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`run ${runId}`);
      expect(result.stdout).toContain('(run-digest)');
      expect((await cli('verify.js', [], env)).code).toBe(0);
    });

    it('exits 1 naming the run when one of its run_decisions is edited', async () => {
      const runId = await post();

      const result = await verifyWhileEdited(async () => {
        const saved = await pool.query<{ decision: unknown }>(
          `SELECT decision FROM run_decisions WHERE run_id = $1 AND decision->>'seam' = 'plan.callLlm'`,
          [runId],
        );
        await pool.query(
          `UPDATE run_decisions
           SET decision = jsonb_set(decision, '{response,value,content}', '"an edited plan"')
           WHERE run_id = $1 AND decision->>'seam' = 'plan.callLlm'`,
          [runId],
        );
        return async () => {
          await pool.query(
            `UPDATE run_decisions SET decision = $2
             WHERE run_id = $1 AND decision->>'seam' = 'plan.callLlm'`,
            [runId, JSON.stringify(saved.rows[0]!.decision)],
          );
        };
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`FAILED at seq`);
      expect(result.stdout).toContain(`run ${runId}`);
      expect((await cli('verify.js', [], env)).code).toBe(0);
    });

    it('commits a run on model replay, served from the committed cassettes, and catches an edit to it', async () => {
      const reached = watchForModelRequests(() => {});
      const task = loadMemoryRecallSuite(1).tasks.find(
        (entry) => entry.id === 'memory-recall-001',
      )!;
      const harness = await createAgentServiceHarness(
        replayDecks(MEMORY_RECALL_DATASET_DIR, [{ taskId: task.id, trials: 1 }]),
      );
      let runId: string;
      try {
        await harness.reset(task);
        runId = (await harness.run(task)).runId;
      } finally {
        await harness.close();
      }

      const axis = await pool.query<{ model_axis: string }>(
        'SELECT model_axis FROM run_records WHERE run_id = $1',
        [runId],
      );
      expect(axis.rows[0]?.model_axis).toBe('replay');
      expect(await entriesFor(runId)).toHaveLength(1);
      expect((await cli('verify.js', [], env)).code).toBe(0);

      const edited = await verifyWhileEdited(async () => {
        const saved = await pool.query<{ blob: Buffer }>(
          `SELECT blob FROM checkpoint_blobs WHERE thread_id = $1 AND channel = 'currentPlan'`,
          [runId],
        );
        await pool.query(
          `UPDATE checkpoint_blobs SET blob = convert_to('"an edited plan"', 'UTF8')
           WHERE thread_id = $1 AND channel = 'currentPlan'`,
          [runId],
        );
        return async () => {
          await pool.query(
            `UPDATE checkpoint_blobs SET blob = $2 WHERE thread_id = $1 AND channel = 'currentPlan'`,
            [runId, saved.rows[0]!.blob],
          );
        };
      });
      expect(edited.code).toBe(1);
      expect(edited.stdout).toContain(`run ${runId}`);
      expect(reached()).toEqual([]);
    });

    it('answers POST /runs with the ledger’s database stopped, and ledger:verify lists the run as uncommitted', async () => {
      // Stopped as far as the service can tell: no connection is accepted and
      // every open one is cut, mid-flight, as a crashed server would.
      await admin.query(`ALTER DATABASE ${service.name} ALLOW_CONNECTIONS false`);
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [service.name],
      );
      let runId: string;
      try {
        runId = await post();
      } finally {
        await admin.query(`ALTER DATABASE ${service.name} ALLOW_CONNECTIONS true`);
      }

      expect(await entriesFor(runId)).toEqual([]);
      const verified = await cli('verify.js', [], env);
      expect(verified.code).toBe(0);
      expect(verified.stdout).toMatch(/uncommitted runs \(\d+\):/);
      expect(verified.stdout).toContain(`  ${runId}`);
    });
  });

  describe('the decision path: $submit and the clinician’s determination', () => {
    async function submit(task: string): Promise<string> {
      const response = await request(app.getHttpServer())
        .post('/fhir/Claim/$submit')
        .set('Content-Type', 'application/fhir+json')
        .send(readFileSync(join(BUNDLES, `${task}.bundle.json`), 'utf8'));
      expect(response.status).toBe(200);
      const latest = await pool.query<{ run_id: string }>(
        `SELECT run_id FROM run_records WHERE graph = 'prior-auth' ORDER BY started_at DESC LIMIT 1`,
      );
      return latest.rows[0]!.run_id;
    }

    async function signedDenial(caseId: string) {
      const view = await request(app.getHttpServer()).get(`/review/cases/${caseId}`);
      expect(view.status).toBe(200);
      const signing = (
        view.body as { signing: { runId: string; recommendationSeq: number | null } }
      ).signing;
      return signDetermination({
        privateKeyPem: PHYSICIAN.privateKeyPem,
        reviewerKeyId: PHYSICIAN.entry.reviewerKeyId,
        signing,
        determination: {
          kind: 'denial',
          specificReason: 'Synthetic fixture: the sleep study does not document the criterion.',
          attestation: {
            reviewerId: PHYSICIAN.entry.reviewerId,
            credential: PHYSICIAN.entry.credential,
            attestedAt: '2026-10-08T12:00:00+00:00',
          },
        },
      });
    }

    it('registers the reviewer registry’s key in the ledger at boot', async () => {
      const rows = await service.ledger.readRows();
      const registration = rows.entries.find(
        (entry) => entry.entryId === uuidV5(`${PHYSICIAN.entry.reviewerKeyId}\nregistered`),
      );
      expect(registration?.kind).toBe('reviewer-key.registered');
    });

    it('commits a referral and its recommendation, and the case cites the recommendation', async () => {
      const caseId = await submit('pa-e0601-one-missing');

      const entries = await entriesFor(caseId);
      expect(entries.map((entry) => entry.kind)).toEqual([
        'run.recorded',
        'disposition.recommended',
      ]);
      const view = await request(app.getHttpServer()).get(`/review/cases/${caseId}`);
      expect(
        (view.body as { signing: { recommendationSeq: number } }).signing.recommendationSeq,
      ).toBe(entries[1]!.seq);
    });

    it('appends one determination.attested entry under the derived id for a denial, and ledger:verify exits 0', async () => {
      const caseId = await submit('pa-e0601-one-missing');
      // Signed first: supertest listens when the request is built, and the
      // read inside signedDenial would close that listener under it.
      const body = await signedDenial(caseId);

      const decided = await request(app.getHttpServer())
        .post(`/review/cases/${caseId}/determination`)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(decided.status).toBe(200);

      const rows = await service.ledger.readRows();
      const attested = rows.entries.filter((entry) => entry.kind === 'determination.attested');
      expect(
        attested.filter((entry) => entry.entryId === uuidV5(`${caseId}\ndetermination`)),
      ).toHaveLength(1);
      const verified = await cli('verify.js', [], env);
      expect(verified.code).toBe(0);
      expect(verified.stdout).toMatch(/determination\.attested \d+/);
    });

    it('answers 503 with the ledger’s database stopped, and the case stays pended', async () => {
      const caseId = await submit('pa-e0601-one-missing');
      const body = await signedDenial(caseId);

      await admin.query(`ALTER DATABASE ${service.name} ALLOW_CONNECTIONS false`);
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [service.name],
      );
      let status: number;
      try {
        status = (
          await request(app.getHttpServer())
            .post(`/review/cases/${caseId}/determination`)
            .set('Content-Type', 'application/json')
            .send(body)
        ).status;
      } finally {
        await admin.query(`ALTER DATABASE ${service.name} ALLOW_CONNECTIONS true`);
      }

      expect(status).toBe(503);
      const view = await request(app.getHttpServer()).get(`/review/cases/${caseId}`);
      expect((view.body as { status: string }).status).toBe('pended');
      expect((await entriesFor(caseId)).map((entry) => entry.kind)).not.toContain(
        'determination.attested',
      );
    });
  });

  describe('anchoring', () => {
    it('ledger:anchor stores a token from the local test TSA that ledger:verify checks', async () => {
      await post();
      const anchored = await cli('anchor.js', [], { ...env, LEDGER_TSA_URL: tsa.url });
      expect(anchored.code).toBe(0);
      expect(anchored.stdout).toContain('the token verifies against LEDGER_TSA_CA');

      const verified = await cli('verify.js', [], env);
      expect(verified.code).toBe(0);
      expect(verified.stdout).toMatch(/anchors: 1, last at seq \d+, verified against the CA/);
      expect(tsa.requests()).toBe(1);

      const without = await cli('verify.js', [], {
        LEDGER_DATABASE_URL: service.writerUrl,
        LEDGER_TSA_CA: '',
      });
      expect(without.code).toBe(2);
    });
  });

  describe('ledger:verify --chain-only, against each edit', () => {
    let db: LedgerDb;

    /** keys at 0, run at 1, recommendation at 2, run at 3, run at 4. */
    async function seeded() {
      db = await createLedgerDb(admin);
      const reviewer = syntheticReviewer(1);
      const runId = randomUUID();
      await db.ledger.append({ entryId: uuidV5('key'), payload: reviewer.registration });
      const run = await db.ledger.append({ entryId: uuidV5('run'), payload: runPayload(runId) });
      await db.ledger.append({
        entryId: uuidV5('rec'),
        payload: {
          kind: 'disposition.recommended',
          runId,
          runEntrySeq: run.entry.seq,
          disposition: { kind: 'refer-to-clinician', findings: [] },
        },
      });
      await db.ledger.append({ entryId: uuidV5('run-3'), payload: runPayload(randomUUID()) });
      await db.ledger.append({ entryId: uuidV5('run-4'), payload: runPayload(randomUUID()) });
      return { reviewer, runId };
    }

    const verify = () => cli('verify.js', ['--chain-only'], { LEDGER_DATABASE_URL: db.writerUrl });

    async function expectFailureAt(seq: number, check: string): Promise<void> {
      const result = await verify();
      try {
        expect(result.code).toBe(1);
        expect(result.stdout).toContain(`FAILED at seq ${seq} (${check})`);
      } finally {
        await db.drop();
      }
    }

    it('passes an untouched chain', async () => {
      await seeded();
      const result = await verify();
      await db.drop();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('runs: not checked (--chain-only)');
    });

    it('exits 1 at the seq of an edited payload', async () => {
      await seeded();
      await asDba(db.owner, async (client) => {
        await client.query(
          `UPDATE ledger_payloads SET payload = replace(payload, '"success"', '"error"')
           WHERE entry_id = (SELECT entry_id FROM ledger_entries WHERE seq = 3)`,
        );
      });
      await expectFailureAt(3, 'commitment');
    });

    it('exits 1 at the seq of an edited row', async () => {
      await seeded();
      await asDba(db.owner, async (client) => {
        await client.query(`UPDATE ledger_entries SET recorded_at = now() WHERE seq = 2`);
      });
      await expectFailureAt(2, 'entry-hash');
    });

    it('exits 1 at the seq of a deleted middle entry', async () => {
      await seeded();
      await asDba(db.owner, async (client) => {
        await client.query('DELETE FROM ledger_entries WHERE seq = 2');
      });
      await expectFailureAt(2, 'sequence');
    });

    it('exits 1 at the first of two swapped entries', async () => {
      await seeded();
      await asDba(db.owner, async (client) => {
        await client.query('UPDATE ledger_entries SET seq = 1000000 WHERE seq = 3');
        await client.query('UPDATE ledger_entries SET seq = 3 WHERE seq = 4');
        await client.query('UPDATE ledger_entries SET seq = 4 WHERE seq = 1000000');
      });
      await expectFailureAt(3, 'link');
    });

    it('exits 1 at an attestation signed by an unregistered key', async () => {
      const { runId } = await seeded();
      const seq = await forge(db, syntheticReviewer(2).attest(runId, 2));
      await expectFailureAt(seq, 'signature');
    });

    it('exits 1 at an attestation signed by a revoked key', async () => {
      const { reviewer, runId } = await seeded();
      await db.ledger.append({
        entryId: uuidV5('revoke'),
        payload: {
          kind: 'reviewer-key.revoked',
          reviewerKeyId: 'synthetic-key-001',
          reason: 'Synthetic fixture: rotated.',
        },
      });
      const seq = await forge(db, reviewer.attest(runId, 2));
      await expectFailureAt(seq, 'signature');
    });

    it('reports a deleted payload as withheld and exits 0', async () => {
      await seeded();
      await db.owner.query(
        'DELETE FROM ledger_payloads WHERE entry_id = (SELECT entry_id FROM ledger_entries WHERE seq = 4)',
      );
      const result = await verify();
      await db.drop();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('withheld payloads (not a failure): seq 4');
    });
  });

  describe('the documented limit, through the commands', () => {
    /**
     * Five runs, anchored at seq 2 by `ledger:anchor`, then a consistent
     * rewrite as a database administrator: one payload edited, and its
     * commitment and every hash from there on recomputed so the chain links.
     */
    async function rewrittenFrom(seq: number): Promise<CliResult> {
      const db = await createLedgerDb(admin);
      try {
        for (const n of [0, 1, 2]) {
          await db.ledger.append({
            entryId: uuidV5(`limit-${n}`),
            payload: runPayload(randomUUID()),
          });
        }
        const anchored = await cli('anchor.js', [], {
          LEDGER_DATABASE_URL: db.writerUrl,
          LEDGER_TSA_URL: tsa.url,
        });
        expect(anchored.stdout).toContain('anchored seq 2');
        for (const n of [3, 4]) {
          await db.ledger.append({
            entryId: uuidV5(`limit-${n}`),
            payload: runPayload(randomUUID()),
          });
        }

        const rows = await db.ledger.readRows();
        const payloads = new Map(rows.payloads.map((row) => [row.entryId, row]));
        await asDba(db.owner, async (client) => {
          let previous = rows.entries[seq - 1]!.entryHash;
          for (const entry of rows.entries.filter((candidate) => candidate.seq >= seq)) {
            const stored = payloads.get(entry.entryId)!;
            const text =
              entry.seq === seq ? stored.payload.replace('"success"', '"error"') : stored.payload;
            const fields = {
              ...entry,
              prevHash: previous,
              commitment: commitmentOf(Buffer.from(stored.salt, 'hex'), text),
            };
            const entryHash = entryHashOf(fields);
            await client.query('UPDATE ledger_payloads SET payload = $2 WHERE entry_id = $1', [
              entry.entryId,
              text,
            ]);
            await client.query(
              'UPDATE ledger_entries SET prev_hash = $2, commitment = $3, entry_hash = $4 WHERE seq = $1',
              [
                entry.seq,
                Buffer.from(fields.prevHash, 'hex'),
                Buffer.from(fields.commitment, 'hex'),
                Buffer.from(entryHash, 'hex'),
              ],
            );
            previous = entryHash;
          }
        });
        return await cli('verify.js', ['--chain-only'], {
          LEDGER_DATABASE_URL: db.writerUrl,
          LEDGER_TSA_CA: tsa.caFile,
        });
      } finally {
        await db.drop();
      }
    }

    it('exits 1 on the anchor when the rewrite reaches an anchored entry', async () => {
      const result = await rewrittenFrom(1);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('FAILED at seq 2 (anchor)');
      expect(result.stdout).toContain('message imprint mismatch');
    });

    it('exits 0 when the rewrite is confined to entries after the last anchor — the documented limit', async () => {
      // Not a defect: entries after the last anchor have left no commitment
      // outside the database, so a database administrator can rewrite them
      // consistently and nothing can tell. The report names the window.
      const result = await rewrittenFrom(3);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        'seq 3-4 are after the last anchor, where a database administrator',
      );
    });
  });
});
