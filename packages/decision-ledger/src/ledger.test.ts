import { describe, expect, it } from 'vitest';
import { Ledger, LedgerConflictError, LedgerRefusedError } from './ledger.js';
import { InMemoryLedgerStore } from './memory-store.js';
import { uuidV5 } from './signature.js';
import { verifyChain } from './verify.js';
import {
  SYNTHETIC_RUN,
  attestation,
  recommended,
  registration,
  runRecorded,
  syntheticReviewer,
} from './fixtures.js';
import type { LedgerPayload } from './entry.js';

function ledger() {
  return new Ledger(new InMemoryLedgerStore());
}

const id = (name: string) => uuidV5(name);

async function chainWithRecommendation() {
  const subject = ledger();
  const reviewer = syntheticReviewer(1);
  await subject.append({ entryId: id('key-1'), payload: registration(reviewer) });
  const run = await subject.append({ entryId: id('run'), payload: runRecorded() });
  const recommendation = await subject.append({
    entryId: id('recommendation'),
    payload: recommended(run.entry.seq),
  });
  return { subject, reviewer, recommendationSeq: recommendation.entry.seq };
}

describe('append', () => {
  it('links each entry to the one before it, from 32 zero bytes', async () => {
    const subject = ledger();
    const first = await subject.append({ entryId: id('a'), payload: runRecorded() });
    const second = await subject.append({ entryId: id('b'), payload: recommended(0) });

    expect(first.entry.seq).toBe(0);
    expect(first.entry.prevHash).toBe('0'.repeat(64));
    expect(second.entry.seq).toBe(1);
    expect(second.entry.prevHash).toBe(first.entry.entryHash);
    expect(verifyChain(await subject.readRows())).toMatchObject({ ok: true, entries: 2 });
  });

  it('serialises concurrent appends into one contiguous chain', async () => {
    const subject = ledger();
    const runs = Array.from(
      { length: 20 },
      (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    );
    await Promise.all(
      runs.map((runId) => subject.append({ entryId: id(runId), payload: runRecorded(runId) })),
    );

    const rows = await subject.readRows();
    expect(rows.entries.map((entry) => entry.seq)).toEqual([...Array(20).keys()]);
    expect(verifyChain(rows).ok).toBe(true);
  });

  it('returns the stored entry for a retry with the same id and payload, and throws on another payload', async () => {
    const subject = ledger();
    const first = await subject.append({ entryId: id('retry'), payload: runRecorded() });
    const again = await subject.append({ entryId: id('retry'), payload: runRecorded() });

    expect(again.entry).toEqual(first.entry);
    expect((await subject.readRows()).entries).toHaveLength(1);

    const different = { ...runRecorded(), runDigest: 'ef'.repeat(32) } as LedgerPayload;
    await expect(subject.append({ entryId: id('retry'), payload: different })).rejects.toThrow(
      LedgerConflictError,
    );
  });

  it('refuses a payload that is not a ledger payload, before writing anything', async () => {
    const subject = ledger();
    const malformed = { ...runRecorded(), runDigest: 'not a digest' } as LedgerPayload;
    await expect(subject.append({ entryId: id('bad'), payload: malformed })).rejects.toThrow(
      LedgerRefusedError,
    );
    expect((await subject.readRows()).entries).toHaveLength(0);
  });

  it('refuses a recommendation that does not cite its run’s run.recorded entry', async () => {
    const subject = ledger();
    await subject.append({ entryId: id('key'), payload: registration(syntheticReviewer()) });
    await expect(subject.append({ entryId: id('r'), payload: recommended(0) })).rejects.toThrow(
      /reviewer-key.registered entry, not run.recorded/,
    );
  });
});

describe('appendAttestation', () => {
  it('appends a determination signed by a registered key, citing the run’s recommendation', async () => {
    const { subject, reviewer, recommendationSeq } = await chainWithRecommendation();
    const attested = await subject.appendAttestation({
      entryId: id('determination'),
      payload: attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq }),
    });

    expect(attested.entry.kind).toBe('determination.attested');
    expect(verifyChain(await subject.readRows())).toMatchObject({ ok: true, entries: 4 });
  });

  it('refuses an unsigned determination', async () => {
    const { subject, reviewer, recommendationSeq } = await chainWithRecommendation();
    const signed = attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq });
    const unsigned = { ...signed, signature: '' };

    await expect(
      subject.appendAttestation({ entryId: id('d'), payload: unsigned }),
    ).rejects.toThrow(/\(payload\): signature/);
    const { signature: _dropped, ...withoutSignature } = signed;
    await expect(
      subject.appendAttestation({ entryId: id('d'), payload: withoutSignature as LedgerPayload }),
    ).rejects.toThrow(LedgerRefusedError);
  });

  it('refuses a signature by a key that is not in the chain', async () => {
    const { subject, recommendationSeq } = await chainWithRecommendation();
    const stranger = syntheticReviewer(9);

    await expect(
      subject.appendAttestation({
        entryId: id('d'),
        payload: attestation({ signer: stranger, runId: SYNTHETIC_RUN, recommendationSeq }),
      }),
    ).rejects.toThrow(/\(signature\): key synthetic-key-009 is not registered/);
  });

  it('refuses a signature that claims a registered key it was not made with', async () => {
    const { subject, reviewer, recommendationSeq } = await chainWithRecommendation();
    const stranger = syntheticReviewer(9);
    const forged = attestation({
      signer: stranger,
      runId: SYNTHETIC_RUN,
      recommendationSeq,
      determination: attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq })
        .determination,
      reviewerKeyId: reviewer.reviewerKeyId,
    });

    await expect(subject.appendAttestation({ entryId: id('d'), payload: forged })).rejects.toThrow(
      /does not verify under key synthetic-key-001/,
    );
  });

  it('refuses a determination on a run with a recommendation that does not cite it', async () => {
    const { subject, reviewer } = await chainWithRecommendation();

    await expect(
      subject.appendAttestation({
        entryId: id('d'),
        payload: attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq: null }),
      }),
    ).rejects.toThrow(/carries the recommendation at seq 2, and the determination cites none/);
  });

  it('refuses a key after its revocation, and keeps what it signed before', async () => {
    const { subject, reviewer, recommendationSeq } = await chainWithRecommendation();
    await subject.appendAttestation({
      entryId: id('before'),
      payload: attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq }),
    });
    await subject.append({
      entryId: id('revoke'),
      payload: {
        kind: 'reviewer-key.revoked',
        reviewerKeyId: reviewer.reviewerKeyId,
        reason: 'Synthetic: rotated.',
      },
    });

    await expect(
      subject.appendAttestation({
        entryId: id('after'),
        payload: attestation({ signer: reviewer, runId: SYNTHETIC_RUN, recommendationSeq }),
      }),
    ).rejects.toThrow(/was revoked at seq 4/);
    expect(verifyChain(await subject.readRows()).ok).toBe(true);
  });

  it('takes nothing but an attestation', async () => {
    await expect(
      ledger().appendAttestation({ entryId: id('x'), payload: runRecorded() }),
    ).rejects.toThrow(/takes determination.attested, not run.recorded/);
  });
});
