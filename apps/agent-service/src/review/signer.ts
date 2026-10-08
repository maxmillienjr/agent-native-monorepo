import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import type { ReviewerRegistryEntry } from './registry.js';
import { signedBytes } from './signature.js';

/**
 * The reviewer's side of a determination, for the demo and nothing else
 * (P3-E). In a deployment this runs in the reviewer's client, on a key the
 * service never sees; here it runs on a key file the CLI writes under a
 * gitignored `.review-keys/`. The service itself only ever verifies.
 */

/** A new Ed25519 keypair: the private key as PKCS#8 PEM, and the registry entry for its public half. */
export function generateReviewerKey(entry: Omit<ReviewerRegistryEntry, 'publicKey'>): {
  readonly privateKeyPem: string;
  readonly entry: ReviewerRegistryEntry;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('the generated key has no public half');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    entry: { ...entry, publicKey: x },
  };
}

/**
 * The body of `POST /review/cases/:caseId/determination`: the determination,
 * signed over the bytes `GET /review/cases/:caseId` names in `signing`.
 */
export function signDetermination(input: {
  readonly privateKeyPem: string;
  readonly reviewerKeyId: string;
  readonly signing: { readonly runId: string; readonly recommendationSeq: number | null };
  readonly determination: object;
}): {
  readonly determination: object;
  readonly recommendationSeq: number | null;
  readonly reviewerKeyId: string;
  readonly signature: string;
} {
  const bytes = signedBytes({
    determination: input.determination,
    recommendationSeq: input.signing.recommendationSeq,
    caseId: input.signing.runId,
  });
  return {
    determination: input.determination,
    recommendationSeq: input.signing.recommendationSeq,
    reviewerKeyId: input.reviewerKeyId,
    signature: sign(null, bytes, createPrivateKey(input.privateKeyPem)).toString('base64url'),
  };
}
