import { z } from 'zod';
import pg from 'pg';
import {
  APPEAL_KINDS,
  LedgerAnchorSchema,
  LedgerEntrySchema,
  LedgerPayloadRowSchema,
  LedgerPayloadSchema,
  type LedgerAnchor,
  type LedgerEntry,
  type LedgerPayloadRow,
  type LedgerRows,
} from './entry.js';
import {
  caseOf,
  referencedSeqs,
  runOf,
  type LedgerStore,
  type LedgerTransaction,
} from './ledger.js';
import { ChainState } from './rules.js';

/**
 * The ledger in Postgres, written as `ledger_writer`, which can `SELECT` and
 * `INSERT` and nothing else (`roles.sql`).
 *
 * Every row is parsed on the way out: this is a database boundary, and a row
 * edited into something that is not an entry must fail the read, not reach the
 * verifier as a cast.
 */

/**
 * The advisory-lock key every append takes. Any constant would do; this one
 * is the ASCII of "ledger", so it is recognisable in `pg_locks`.
 */
export const LEDGER_LOCK_KEY = 0x6c6564676572;

const EntryRowSchema = z.object({
  seq: z.union([z.string(), z.number()]),
  entry_id: z.string(),
  kind: z.string(),
  recorded_at: z.date(),
  prev_hash: z.instanceof(Buffer),
  commitment: z.instanceof(Buffer),
  entry_hash: z.instanceof(Buffer),
});

const PayloadRowSchema = z.object({
  entry_id: z.string(),
  salt: z.instanceof(Buffer),
  payload: z.string(),
});

const AnchorRowSchema = z.object({
  seq: z.union([z.string(), z.number()]),
  tsa_url: z.string(),
  token: z.instanceof(Buffer),
  anchored_at: z.date(),
});

function toEntry(raw: unknown): LedgerEntry {
  const row = EntryRowSchema.parse(raw);
  return LedgerEntrySchema.parse({
    seq: Number(row.seq),
    entryId: row.entry_id,
    kind: row.kind,
    recordedAt: row.recorded_at.toISOString(),
    prevHash: row.prev_hash.toString('hex'),
    commitment: row.commitment.toString('hex'),
    entryHash: row.entry_hash.toString('hex'),
  });
}

function toPayload(raw: unknown): LedgerPayloadRow {
  const row = PayloadRowSchema.parse(raw);
  return LedgerPayloadRowSchema.parse({
    entryId: row.entry_id,
    salt: row.salt.toString('hex'),
    payload: row.payload,
  });
}

function toAnchor(raw: unknown): LedgerAnchor {
  const row = AnchorRowSchema.parse(raw);
  return LedgerAnchorSchema.parse({
    seq: Number(row.seq),
    tsaUrl: row.tsa_url,
    token: row.token.toString('base64'),
    anchoredAt: row.anchored_at.toISOString(),
  });
}

const ENTRY_COLUMNS = 'seq, entry_id, kind, recorded_at, prev_hash, commitment, entry_hash';

export class PgLedgerStore implements LedgerStore {
  constructor(private readonly pool: pg.Pool) {}

  async transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Held to the end of the transaction: every append is one at a time, so
      // reading the head and inserting after it cannot interleave.
      await client.query('SELECT pg_advisory_xact_lock($1)', [LEDGER_LOCK_KEY]);
      const result = await work(transaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readRows(): Promise<LedgerRows> {
    const entries = await this.pool.query(
      `SELECT ${ENTRY_COLUMNS} FROM ledger_entries ORDER BY seq`,
    );
    const payloads = await this.pool.query('SELECT entry_id, salt, payload FROM ledger_payloads');
    const anchors = await this.pool.query(
      'SELECT seq, tsa_url, token, anchored_at FROM ledger_anchors ORDER BY seq',
    );
    return {
      entries: entries.rows.map(toEntry),
      payloads: payloads.rows.map(toPayload),
      anchors: anchors.rows.map(toAnchor),
    };
  }

  async insertAnchor(anchor: LedgerAnchor): Promise<void> {
    const parsed = LedgerAnchorSchema.parse(anchor);
    await this.pool.query(
      'INSERT INTO ledger_anchors (seq, tsa_url, token, anchored_at) VALUES ($1, $2, $3, $4)',
      [parsed.seq, parsed.tsaUrl, Buffer.from(parsed.token, 'base64'), parsed.anchoredAt],
    );
  }
}

function transaction(client: pg.PoolClient): LedgerTransaction {
  return {
    async head() {
      const result = await client.query(
        `SELECT ${ENTRY_COLUMNS} FROM ledger_entries ORDER BY seq DESC LIMIT 1`,
      );
      return result.rows[0] === undefined ? null : toEntry(result.rows[0]);
    },

    async byEntryId(entryId) {
      const result = await client.query(
        `SELECT e.seq, e.entry_id, e.kind, e.recorded_at, e.prev_hash, e.commitment, e.entry_hash,
                p.salt, p.payload
           FROM ledger_entries e LEFT JOIN ledger_payloads p USING (entry_id)
          WHERE e.entry_id = $1`,
        [entryId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return {
        entry: toEntry(row),
        payload: row['payload'] === null ? null : toPayload(row),
      };
    },

    async stateFor(payload) {
      // Narrower than the whole chain, and enough: the rules ask about keys,
      // about this payload's run, about the appeals on its case (P3-F), and
      // about the seqs it cites.
      const result = await client.query(
        `SELECT e.seq, e.kind, p.payload
           FROM ledger_entries e LEFT JOIN ledger_payloads p USING (entry_id)
          WHERE e.kind LIKE 'reviewer-key.%'
             OR (e.kind IN ('run.recorded', 'disposition.recommended')
                 AND p.payload IS NOT NULL AND (p.payload::jsonb ->> 'runId') = $1)
             OR (e.kind = ANY($3::text[])
                 AND p.payload IS NOT NULL AND (p.payload::jsonb ->> 'caseId') = $4)
             OR e.seq = ANY($2::bigint[])
          ORDER BY e.seq`,
        [runOf(payload), referencedSeqs(payload), [...APPEAL_KINDS], caseOf(payload)],
      );
      const state = new ChainState();
      for (const raw of result.rows) {
        const row = z
          .object({
            seq: z.union([z.string(), z.number()]),
            kind: z.string(),
            payload: z.string().nullable(),
          })
          .parse(raw);
        const seq = Number(row.seq);
        if (row.payload === null) state.applyWithheld(seq, row.kind);
        else state.apply(seq, LedgerPayloadSchema.parse(JSON.parse(row.payload)));
      }
      return state;
    },

    async insert(entry, payload) {
      await client.query(
        `INSERT INTO ledger_entries (seq, entry_id, kind, recorded_at, prev_hash, commitment, entry_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.seq,
          entry.entryId,
          entry.kind,
          entry.recordedAt,
          Buffer.from(entry.prevHash, 'hex'),
          Buffer.from(entry.commitment, 'hex'),
          Buffer.from(entry.entryHash, 'hex'),
        ],
      );
      await client.query(
        'INSERT INTO ledger_payloads (entry_id, salt, payload) VALUES ($1, $2, $3)',
        [payload.entryId, Buffer.from(payload.salt, 'hex'), payload.payload],
      );
    },
  };
}

/**
 * A pool for the ledger's writer, or for a verifier with `readOnly`.
 *
 * Timeouts are short on purpose: a ledger that stops answering must not hold
 * a run. And an `error` listener is attached, because an idle client whose
 * server goes away emits one, and unheard that is an uncaught exception that
 * takes the whole service down — the outage a ledger outage must not become.
 */
export function createLedgerPool(
  connectionString: string,
  options: { readonly readOnly?: boolean; readonly onError?: (error: Error) => void } = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    ...(options.readOnly === true ? { options: '-c default_transaction_read_only=on' } : {}),
  });
  pool.on('error', options.onError ?? (() => undefined));
  return pool;
}
