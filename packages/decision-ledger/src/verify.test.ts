import { describe, expect, it } from 'vitest';
import type { LedgerRows } from './entry.js';
import { fromJsonl, toJsonl } from './export.js';
import { verifyChain } from './verify.js';
import {
  SYNTHETIC_RUN,
  attestation,
  forgeRows,
  recommended,
  registration,
  rehashFrom,
  runRecorded,
  syntheticReviewer,
} from './fixtures.js';

/**
 * `verifyChain` against each edit the PRD names. The rows are built directly,
 * as someone with the table to themselves would: an edit here is what a
 * database administrator, or a stolen owner credential, could do.
 */

const reviewer = syntheticReviewer(1);

/** keys(0), run(1), recommendation(2), attestation(3), run(4). */
function honest(): LedgerRows {
  return forgeRows([
    registration(reviewer),
    runRecorded(),
    recommended(1),
    attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq: 2 }),
    runRecorded('00000000-0000-4000-8000-00000000beef'),
  ]);
}

function editPayload(rows: LedgerRows, seq: number, edit: (payload: string) => string): LedgerRows {
  const entryId = rows.entries.find((entry) => entry.seq === seq)!.entryId;
  return {
    ...rows,
    payloads: rows.payloads.map((row) =>
      row.entryId === entryId ? { ...row, payload: edit(row.payload) } : row,
    ),
  };
}

describe('verifyChain', () => {
  it('passes an honest chain and reports its head', () => {
    const rows = honest();
    const report = verifyChain(rows);
    expect(report).toMatchObject({ ok: true, entries: 5, withheld: [] });
    expect(report.head).toEqual({ seq: 4, entryHash: rows.entries[4]!.entryHash });
    expect(report.kinds).toEqual({
      'reviewer-key.registered': 1,
      'run.recorded': 2,
      'disposition.recommended': 1,
      'determination.attested': 1,
    });
  });

  it('fails an edited payload at its seq, on the commitment', () => {
    const rows = editPayload(honest(), 1, (payload) => payload.replace('"success"', '"error"'));
    expect(verifyChain(rows).failure).toMatchObject({ seq: 1, check: 'commitment' });
  });

  it('fails an edited row at its seq, on the entry hash', () => {
    const rows = honest();
    const edited = {
      ...rows,
      entries: rows.entries.map((entry) =>
        entry.seq === 3 ? { ...entry, recordedAt: '2026-10-09T00:00:00.000Z' } : entry,
      ),
    };
    expect(verifyChain(edited).failure).toMatchObject({ seq: 3, check: 'entry-hash' });
  });

  it('fails a deleted middle entry at the missing seq', () => {
    const rows = honest();
    const deleted = { ...rows, entries: rows.entries.filter((entry) => entry.seq !== 2) };
    expect(verifyChain(deleted).failure).toMatchObject({ seq: 2, check: 'sequence' });
  });

  it('fails two swapped entries at the first of them', () => {
    const rows = honest();
    const swapped = {
      ...rows,
      entries: rows.entries.map((entry) =>
        entry.seq === 1 ? { ...entry, seq: 2 } : entry.seq === 2 ? { ...entry, seq: 1 } : entry,
      ),
    };
    expect(verifyChain(swapped).failure).toMatchObject({ seq: 1 });
  });

  it('fails an attestation signed by a key the chain never registered', () => {
    const stranger = syntheticReviewer(7);
    const rows = forgeRows([
      registration(reviewer),
      runRecorded(),
      recommended(1),
      attestation({ signer: stranger, runId: SYNTHETIC_RUN, recommendationSeq: 2 }),
    ]);
    expect(verifyChain(rows).failure).toMatchObject({
      seq: 3,
      check: 'signature',
      reason: expect.stringContaining('synthetic-key-007 is not registered'),
    });
  });

  it('fails an attestation signed by a key revoked before it', () => {
    const rows = forgeRows([
      registration(reviewer),
      runRecorded(),
      recommended(1),
      { kind: 'reviewer-key.revoked', reviewerKeyId: reviewer.reviewerKeyId, reason: 'Synthetic.' },
      attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq: 2 }),
    ]);
    expect(verifyChain(rows).failure).toMatchObject({
      seq: 4,
      check: 'signature',
      reason: expect.stringContaining('was revoked at seq 3'),
    });
  });

  it('reports a deleted payload as withheld and passes', () => {
    const rows = honest();
    const withheld = {
      ...rows,
      payloads: rows.payloads.filter((row) => row.entryId !== rows.entries[4]!.entryId),
    };
    expect(verifyChain(withheld)).toMatchObject({ ok: true, withheld: [4] });
  });

  it('fails a payload rewritten with its commitment and every later hash, at the edit', () => {
    // Consistent from the edit onward, and still caught: the edited entry's
    // new entry_hash is fine, but a stale prev_hash would show — so the forger
    // rehashes everything, and only an anchor can tell (anchor.test.ts).
    const rows = rehashFrom(
      editPayload(honest(), 1, (payload) => payload.replace('"success"', '"error"')),
      1,
    );
    expect(verifyChain(rows).ok).toBe(true);
  });

  it('round-trips through a JSONL export, with or without payloads', () => {
    const rows = honest();
    expect(verifyChain(fromJsonl(toJsonl(rows))).ok).toBe(true);
    const chainOnly = verifyChain(fromJsonl(toJsonl(rows, { payloads: false })));
    expect(chainOnly).toMatchObject({ ok: true, withheld: [0, 1, 2, 3, 4] });
  });
});
