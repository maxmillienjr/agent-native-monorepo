import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anchorHead,
  parseOpenSslTime,
  timestampQuery,
  requestTimestamp,
  verifyAnchors,
  verifyTimestamp,
} from './anchor.js';
import type { LedgerRows } from './entry.js';
import { Ledger } from './ledger.js';
import { InMemoryLedgerStore } from './memory-store.js';
import { uuidV5 } from './signature.js';
import { startTestTsa, type TestTsa } from './testing/test-tsa.js';
import { forgeRows, rehashFrom, runRecorded } from './fixtures.js';

/**
 * RFC 3161 against a TSA on localhost, made in the test: no network. The
 * second half is the threat model's DBA row, both ways round.
 */

let tsa: TestTsa;

beforeAll(async () => {
  tsa = await startTestTsa();
});

afterAll(async () => {
  await tsa?.close();
});

const run = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('a timestamp token', () => {
  it('verifies against the CA over the hash it was requested for, and over no other', async () => {
    const hash = 'ab'.repeat(32);
    const token = await requestTimestamp(tsa.url, await timestampQuery(hash));

    expect(await verifyTimestamp(token, hash, tsa.caFile)).toMatchObject({ ok: true });
    expect(await verifyTimestamp(token, 'cd'.repeat(32), tsa.caFile)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('message imprint mismatch'),
    });
  });

  it('reads OpenSSL’s GeneralizedTime, with and without a fraction', () => {
    expect(parseOpenSslTime('Oct  8 20:11:48 2026 GMT')?.toISOString()).toBe(
      '2026-10-08T20:11:48.000Z',
    );
    expect(parseOpenSslTime('Jan 31 00:00:01.25 2027 GMT')?.toISOString()).toBe(
      '2027-01-31T00:00:01.250Z',
    );
    expect(parseOpenSslTime('yesterday')).toBeNull();
  });
});

describe('anchorHead', () => {
  it('anchors the head once, and the anchor verifies', async () => {
    const ledger = new Ledger(new InMemoryLedgerStore());
    expect(await anchorHead(ledger, { tsaUrl: tsa.url })).toEqual({ kind: 'empty' });

    await ledger.append({ entryId: uuidV5('a'), payload: runRecorded(run(1)) });
    await ledger.append({ entryId: uuidV5('b'), payload: runRecorded(run(2)) });
    const anchored = await anchorHead(ledger, { tsaUrl: tsa.url, caFile: tsa.caFile });
    expect(anchored).toMatchObject({ kind: 'anchored', anchor: { seq: 1, tsaUrl: tsa.url } });
    expect(await anchorHead(ledger, { tsaUrl: tsa.url })).toMatchObject({
      kind: 'already-anchored',
    });

    const rows = await ledger.readRows();
    expect(await verifyAnchors(rows.entries, rows.anchors, tsa.caFile)).toBeNull();
  });
});

describe('the documented limit', () => {
  /** Five runs, anchored at seq 2. */
  async function anchoredAtTwo(): Promise<LedgerRows> {
    const rows = forgeRows([1, 2, 3, 4, 5].map((n) => runRecorded(run(n))));
    const hash = rows.entries[2]!.entryHash;
    const token = await requestTimestamp(tsa.url, await timestampQuery(hash));
    return {
      ...rows,
      anchors: [
        {
          seq: 2,
          tsaUrl: tsa.url,
          token: token.toString('base64'),
          anchoredAt: new Date().toISOString(),
        },
      ],
    };
  }

  function rewritePayload(rows: LedgerRows, seq: number): LedgerRows {
    const entryId = rows.entries.find((entry) => entry.seq === seq)!.entryId;
    return rehashFrom(
      {
        ...rows,
        payloads: rows.payloads.map((row) =>
          row.entryId === entryId
            ? { ...row, payload: row.payload.replace('"success"', '"error"') }
            : row,
        ),
      },
      seq,
    );
  }

  it('catches a consistent rewrite from an anchored entry onward, on the anchor', async () => {
    const rewritten = rewritePayload(await anchoredAtTwo(), 1);
    expect(await verifyAnchors(rewritten.entries, rewritten.anchors, tsa.caFile)).toMatchObject({
      seq: 2,
      reason: expect.stringContaining('message imprint mismatch'),
    });
  });

  it('cannot catch the same rewrite confined to entries after the last anchor', async () => {
    // This is the PRD's stated limit, not a defect: entries after the last
    // anchor have left no commitment outside the database, so a database
    // administrator can rewrite them consistently and nothing here can tell.
    // The window is the interval between anchors.
    const rewritten = rewritePayload(await anchoredAtTwo(), 3);
    expect(await verifyAnchors(rewritten.entries, rewritten.anchors, tsa.caFile)).toBeNull();
  });
});
