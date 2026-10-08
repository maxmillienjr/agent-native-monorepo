import { describe, expect, it } from 'vitest';
import type { LedgerPayload } from './entry.js';
import { Ledger, LedgerRefusedError } from './ledger.js';
import { InMemoryLedgerStore } from './memory-store.js';
import { uuidV5 } from './signature.js';
import { verifyChain } from './verify.js';
import {
  SYNTHETIC_RUN,
  appealFiled,
  attestation,
  dismissed,
  forgeRows,
  forwarded,
  reconsideration,
  recommended,
  registration,
  runRecorded,
  syntheticReviewer,
} from './fixtures.js';

/**
 * The four appeal kinds (P3-F) on append and in the verifier: one set of
 * rules, so a chain the append would refuse fails `verifyChain` at the same
 * entry for the same reason.
 */

const denier = syntheticReviewer(1);
const other = syntheticReviewer(2);
/** The denier under a second key: one person to § 422.590(h)(1). */
const denierSecondKey = { ...syntheticReviewer(9), reviewerId: denier.reviewerId };

/** keys(0-2), run(3), recommendation(4), denial(5), appeal(6). */
const PREFIX: LedgerPayload[] = [
  registration(denier),
  registration(other),
  registration(denierSecondKey),
  runRecorded(),
  recommended(3),
  attestation({ signer: denier, runId: SYNTHETIC_RUN, recommendationSeq: 4 }),
  appealFiled(5),
];
const DETERMINATION = 5;
const APPEAL = 6;

async function appended(payloads: readonly LedgerPayload[]): Promise<Ledger> {
  const ledger = new Ledger(new InMemoryLedgerStore());
  for (const [index, payload] of payloads.entries()) {
    await ledger.append({ entryId: uuidV5(`entry-${index}`), payload });
  }
  return ledger;
}

describe('appeal entries (P3-F)', () => {
  it('appends a filing, an affirmation by another physician and the forward, and verifies', async () => {
    const ledger = await appended([
      ...PREFIX,
      reconsideration({
        signer: other,
        initial: denier,
        appealSeq: APPEAL,
        determinationSeq: DETERMINATION,
      }),
      forwarded(APPEAL),
    ]);
    const report = verifyChain(await ledger.readRows());
    expect(report).toMatchObject({ ok: true, entries: 9 });
    expect(report.kinds).toMatchObject({
      'appeal.filed': 1,
      'reconsideration.attested': 1,
      'appeal.forwarded': 1,
    });
    const found = await ledger.find(uuidV5('entry-6'));
    expect(found?.entry.seq).toBe(APPEAL);
    expect(await ledger.find(uuidV5('absent'))).toBeNull();
  });

  it('refuses a reconsideration by the denier under a second key, on append and in the verifier', async () => {
    const own = reconsideration({
      signer: denierSecondKey,
      initial: denier,
      appealSeq: APPEAL,
      determinationSeq: DETERMINATION,
    });
    const ledger = await appended(PREFIX);
    await expect(ledger.append({ entryId: uuidV5('own'), payload: own })).rejects.toMatchObject({
      check: 'involvement',
    });

    // Planted past the append, as the table's owner could.
    const report = verifyChain(forgeRows([...PREFIX, own]));
    expect(report.ok).toBe(false);
    expect(report.failure).toMatchObject({ seq: 7, check: 'involvement' });
    expect(report.failure?.reason).toContain(`${denier.reviewerId}'s`);
  });

  it('refuses a dismissal by the denier too', async () => {
    const ledger = await appended(PREFIX);
    await expect(
      ledger.append({
        entryId: uuidV5('dismissed'),
        payload: dismissed({
          signer: denier,
          appealSeq: APPEAL,
          determinationSeq: DETERMINATION,
        }),
      }),
    ).rejects.toMatchObject({ check: 'involvement' });
  });

  it('refuses a signature over another appeal, and an initial reviewer the denial does not name', async () => {
    const ledger = await appended(PREFIX);
    const moved = reconsideration({
      signer: other,
      initial: denier,
      appealSeq: APPEAL,
      determinationSeq: DETERMINATION,
      signFor: '00000000-0000-4000-8000-0000000b0b0b',
    });
    await expect(ledger.append({ entryId: uuidV5('moved'), payload: moved })).rejects.toMatchObject(
      { check: 'signature' },
    );
    const misnamed = reconsideration({
      signer: other,
      initial: syntheticReviewer(3),
      appealSeq: APPEAL,
      determinationSeq: DETERMINATION,
    });
    await expect(
      ledger.append({ entryId: uuidV5('misnamed'), payload: misnamed }),
    ).rejects.toMatchObject({ check: 'reference' });
  });

  it('refuses what the lifecycle does not allow', async () => {
    const reconsidered = (kind: 'reversal' | 'affirmation') =>
      reconsideration({
        signer: other,
        initial: denier,
        appealSeq: APPEAL,
        determinationSeq: DETERMINATION,
        kind,
      });
    const refused: [string, LedgerPayload[], LedgerPayload][] = [
      ['a filing that cites the recommendation', PREFIX.slice(0, 6), appealFiled(4)],
      ['a second filing of one appeal', PREFIX, appealFiled(5)],
      ['a forward as affirmed with no affirmation', PREFIX, forwarded(APPEAL)],
      ['a forward of a reversed appeal', [...PREFIX, reconsidered('reversal')], forwarded(APPEAL)],
      [
        'a lapse forward after a reconsideration',
        [...PREFIX, reconsidered('affirmation')],
        forwarded(APPEAL, 'deadline-lapsed'),
      ],
      [
        'a second reconsideration',
        [...PREFIX, reconsidered('reversal')],
        reconsidered('affirmation'),
      ],
      [
        'a reconsideration after a lapse forward',
        [...PREFIX, forwarded(APPEAL, 'deadline-lapsed')],
        reconsidered('reversal'),
      ],
    ];
    for (const [label, before, payload] of refused) {
      const ledger = await appended(before);
      const result = await ledger
        .append({ entryId: uuidV5(label), payload })
        .then(() => 'appended')
        .catch((error: unknown) => (error instanceof LedgerRefusedError ? error.check : 'threw'));
      expect({ label, result }).toEqual({ label, result: 'reference' });
    }
  });
});
