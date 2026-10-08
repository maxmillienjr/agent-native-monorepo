import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReviewerRegistry, ReviewerRegistryEntrySchema } from './registry.js';
import { signedBytes, verifySignature } from './signature.js';
import { generateReviewerKey, signDetermination } from './signer.js';

describe('the demo signer', () => {
  it('signs the bytes the service verifies, under a key it registers', () => {
    const { privateKeyPem, entry } = generateReviewerKey({
      reviewerKeyId: 'synthetic-key-demo',
      reviewerId: 'synthetic-reviewer-demo',
      credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
    });
    expect(ReviewerRegistryEntrySchema.parse(entry)).toEqual(entry);
    expect(privateKeyPem).toContain('BEGIN PRIVATE KEY');

    const caseId = randomUUID();
    const determination = {
      kind: 'clinician-approval',
      attestation: {
        reviewerId: 'synthetic-reviewer-demo',
        credential: entry.credential,
        attestedAt: '2026-10-08T12:00:00+00:00',
      },
    };
    const body = signDetermination({
      privateKeyPem,
      reviewerKeyId: entry.reviewerKeyId,
      signing: { runId: caseId, recommendationSeq: null },
      determination,
    });

    const key = new ReviewerRegistry([entry]).active(entry.reviewerKeyId, new Date());
    if (key === undefined) throw new Error('the key did not register');
    const bytes = signedBytes({ determination, recommendationSeq: null, caseId });
    expect(verifySignature(key.publicKey, bytes, body.signature)).toBe(true);
    const otherCase = signedBytes({ determination, recommendationSeq: null, caseId: randomUUID() });
    expect(verifySignature(key.publicKey, otherCase, body.signature)).toBe(false);
  });
});
