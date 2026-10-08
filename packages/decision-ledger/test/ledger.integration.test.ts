import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Ledger, LedgerConflictError, LedgerRefusedError } from '../src/ledger.js';
import { PgLedgerStore } from '../src/pg-store.js';
import { assertWriterRole, runLedgerMigrations } from '../src/migrate.js';
import { verifyChain } from '../src/verify.js';
import { anchorHead, verifyAnchors } from '../src/anchor.js';
import { uuidV5 } from '../src/signature.js';
import { startTestTsa, type TestTsa } from '../src/testing/test-tsa.js';
import {
  SYNTHETIC_RUN,
  attestation,
  recommended,
  registration,
  runRecorded,
  syntheticReviewer,
} from '../src/fixtures.js';
import {
  createLedgerDatabase,
  skipUnlessIntegrationEnv,
  type LedgerDatabase,
} from './integration-env.js';

/**
 * The ledger against a live Postgres (P3-C). What the PRD probed by hand on
 * 2026-09-26, held as tests: the writer role cannot rewrite, the trigger stops
 * the owner, a superuser in replica mode is stopped by nothing in the
 * database, and the chain stays linear under concurrent writers.
 */

const SKIP = skipUnlessIntegrationEnv('decision ledger (integration)', 'DATABASE_URL');

const run = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(SKIP)('decision ledger (integration)', () => {
  let db: LedgerDatabase;
  let ledger: Ledger;
  let tsa: TestTsa;

  beforeAll(async () => {
    db = await createLedgerDatabase('ledger_it');
    ledger = new Ledger(new PgLedgerStore(db.writer));
    tsa = await startTestTsa();
    // seq 0 and 1, for the rewrite probes to aim at.
    await ledger.append({ entryId: uuidV5('probe-0'), payload: runRecorded(run(9000)) });
    await ledger.append({ entryId: uuidV5('probe-1'), payload: runRecorded(run(9001)) });
  });

  afterAll(async () => {
    await tsa?.close();
    await db?.drop();
  });

  async function failure(pool: pg.Pool, sql: string): Promise<string> {
    try {
      await pool.query(sql);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`expected ${sql} to fail`);
  }

  describe('who can rewrite it', () => {
    it('denies ledger_writer UPDATE, DELETE and TRUNCATE on ledger_entries', async () => {
      expect(
        await failure(db.writer, "UPDATE ledger_entries SET kind = 'x' WHERE seq = 0"),
      ).toMatch(/permission denied for table ledger_entries/);
      expect(await failure(db.writer, 'DELETE FROM ledger_entries WHERE seq = 0')).toMatch(
        /permission denied for table ledger_entries/,
      );
      expect(await failure(db.writer, 'TRUNCATE ledger_entries CASCADE')).toMatch(
        /permission denied for table ledger_entries/,
      );
    });

    it('denies ledger_writer a payload DELETE, so only the owner can withhold one', async () => {
      expect(await failure(db.writer, 'DELETE FROM ledger_payloads')).toMatch(
        /permission denied for table ledger_payloads/,
      );
    });

    it('stops the owner with the trigger’s exception', async () => {
      // The owner here is DATABASE_URL's user, which in compose and CI is the
      // superuser: the trigger binds it too, unless it leaves origin mode.
      expect(await failure(db.owner, "UPDATE ledger_entries SET kind = 'x' WHERE seq = 0")).toMatch(
        /the decision ledger is append-only: UPDATE on ledger_entries is refused/,
      );
      expect(await failure(db.owner, 'DELETE FROM ledger_entries WHERE seq = 1')).toMatch(
        /append-only: DELETE on ledger_entries is refused/,
      );
      expect(await failure(db.owner, 'TRUNCATE ledger_entries CASCADE')).toMatch(
        /append-only: TRUNCATE on ledger_entries is refused/,
      );
      expect(await failure(db.owner, "UPDATE ledger_payloads SET payload = '{}'")).toMatch(
        /UPDATE on ledger_payloads is refused/,
      );
    });

    it('does not stop a superuser in replica mode — the threat model’s DBA row', async () => {
      // Nothing inside the database can stop this; an anchor outside it is
      // what detects it. Done in a transaction and rolled back.
      const client = await db.owner.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        const updated = await client.query(
          "UPDATE ledger_entries SET kind = 'rewritten' WHERE seq = 0",
        );
        expect(updated.rowCount).toBe(1);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('rejects a second entry claiming the same predecessor, on the unique constraint', async () => {
      const head = await db.writer.query<{ prev_hash: Buffer }>(
        'SELECT prev_hash FROM ledger_entries WHERE seq = 1',
      );
      const message = await failure(
        db.writer,
        `INSERT INTO ledger_entries (seq, entry_id, kind, recorded_at, prev_hash, commitment, entry_hash)
         VALUES (999999, '${run(77)}', 'run.recorded', now(),
                 '\\x${head.rows[0]!.prev_hash.toString('hex')}', '\\x${'00'.repeat(32)}', '\\x${'11'.repeat(32)}')`,
      );
      expect(message).toMatch(
        /duplicate key value violates unique constraint "ledger_entries_prev_hash_key"/,
      );
    });

    it('lets the service start as ledger_writer, and refuses the owner', async () => {
      await expect(assertWriterRole(db.writer)).resolves.toBeUndefined();
      await expect(assertWriterRole(db.owner)).rejects.toThrow(
        /holds UPDATE, DELETE, TRUNCATE, ownership on ledger_entries/,
      );
    });

    it('migrates idempotently, and refuses a migration whose statements changed after it ran', async () => {
      await expect(runLedgerMigrations(db.owner)).resolves.toBeUndefined();
      const recorded = await db.owner.query<{ tag: string; hash: string }>(
        'SELECT tag, hash FROM __ledger_migrations',
      );
      expect(recorded.rows.map((row) => row.tag)).toEqual(['0000_ledger']);

      await db.owner.query(
        "UPDATE __ledger_migrations SET hash = 'edited' WHERE tag = '0000_ledger'",
      );
      try {
        await expect(runLedgerMigrations(db.owner)).rejects.toThrow(
          /ledger migration 0000_ledger has changed since it was applied/,
        );
      } finally {
        await db.owner.query('UPDATE __ledger_migrations SET hash = $1 WHERE tag = $2', [
          recorded.rows[0]!.hash,
          '0000_ledger',
        ]);
      }
    });
  });

  describe('appending', () => {
    it('keeps fifty concurrent appends from five pools contiguous', async () => {
      // An empty ledger of its own, so the fifty are seq 0-49 exactly.
      const empty = await createLedgerDatabase('ledger_concurrent');
      try {
        const ledgers = Array.from(
          { length: 5 },
          () => new Ledger(new PgLedgerStore(empty.writerPool())),
        );

        await Promise.all(
          Array.from({ length: 50 }, (_, n) =>
            ledgers[n % 5]!.append({
              entryId: uuidV5(`concurrent-${n}`),
              payload: runRecorded(run(n)),
            }),
          ),
        );

        const rows = await new Ledger(new PgLedgerStore(empty.writer)).readRows();
        expect(rows.entries.map((entry) => entry.seq)).toEqual(
          Array.from({ length: 50 }, (_, seq) => seq),
        );
        expect(verifyChain(rows)).toMatchObject({ ok: true, entries: 50 });
      } finally {
        await empty.drop();
      }
    });

    it('returns the original entry for a retry, and throws on a different payload', async () => {
      const entryId = uuidV5('retry');
      const first = await ledger.append({ entryId, payload: runRecorded(run(500)) });
      const again = await ledger.append({ entryId, payload: runRecorded(run(500)) });
      expect(again.entry).toEqual(first.entry);

      await expect(ledger.append({ entryId, payload: runRecorded(run(501)) })).rejects.toThrow(
        LedgerConflictError,
      );
    });

    it('applies the attestation rules through the store’s narrower fold', async () => {
      const reviewer = syntheticReviewer(1);
      await ledger.append({ entryId: uuidV5('key-1'), payload: registration(reviewer) });
      const recorded = await ledger.append({ entryId: uuidV5('run'), payload: runRecorded() });
      const recommendation = await ledger.append({
        entryId: uuidV5('rec'),
        payload: recommended(recorded.entry.seq),
      });

      await expect(
        ledger.appendAttestation({
          entryId: uuidV5('uncited'),
          payload: attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq: null }),
        }),
      ).rejects.toThrow(LedgerRefusedError);
      await expect(
        ledger.appendAttestation({
          entryId: uuidV5('stranger'),
          payload: attestation({
            signer: syntheticReviewer(2),
            runId: SYNTHETIC_RUN,
            recommendationSeq: recommendation.entry.seq,
          }),
        }),
      ).rejects.toThrow(/not registered/);

      await ledger.appendAttestation({
        entryId: uuidV5('determination'),
        payload: attestation({
          signer: reviewer,
          runId: SYNTHETIC_RUN,
          recommendationSeq: recommendation.entry.seq,
        }),
      });
      expect(verifyChain(await ledger.readRows()).ok).toBe(true);
    });
  });

  describe('withholding', () => {
    it('lets the owner withhold a payload, which the verifier reports and passes', async () => {
      const withheld = await ledger.append({
        entryId: uuidV5('withheld'),
        payload: runRecorded(run(600)),
      });
      await db.owner.query('DELETE FROM ledger_payloads WHERE entry_id = $1', [
        withheld.entry.entryId,
      ]);

      const report = verifyChain(await ledger.readRows());
      expect(report.ok).toBe(true);
      expect(report.withheld).toContain(withheld.entry.seq);
    });

    it('never withholds a reviewer key', async () => {
      const key = await db.owner.query<{ entry_id: string }>(
        "SELECT entry_id FROM ledger_entries WHERE kind = 'reviewer-key.registered' LIMIT 1",
      );
      expect(
        await failure(
          db.owner,
          `DELETE FROM ledger_payloads WHERE entry_id = '${key.rows[0]!.entry_id}'`,
        ),
      ).toMatch(/a reviewer key's payload is never withheld/);
    });
  });

  describe('anchoring', () => {
    it('stores a token from the local test TSA that verifies against its CA', async () => {
      const anchored = await anchorHead(ledger, { tsaUrl: tsa.url, caFile: tsa.caFile });
      expect(anchored.kind).toBe('anchored');

      const rows = await ledger.readRows();
      expect(rows.anchors).toHaveLength(1);
      expect(await verifyAnchors(rows.entries, rows.anchors, tsa.caFile)).toBeNull();
      expect(await failure(db.writer, 'DELETE FROM ledger_anchors')).toMatch(/permission denied/);
      expect(await failure(db.owner, 'DELETE FROM ledger_anchors')).toMatch(/append-only/);
    });
  });
});
