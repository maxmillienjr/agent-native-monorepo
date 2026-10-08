import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@repo/agent-cassette';

/**
 * The bytes a reviewer signs, and the check the service makes (P3-E).
 *
 * The service verifies and never signs: it holds no reviewer's private key. If
 * it could sign, a stolen service credential could mint a denial, and P3-C's
 * threat model says forged attestations "fail the signature check" only while
 * that is true.
 *
 * The bytes are P3-C's attestation payload exactly, with the case id as
 * `runId`, so the same signature is accepted by the ledger once one is
 * configured: `canonicalJson({ determination, recommendationSeq, runId })`.
 * The case id inside them is what stops a signature for one case being
 * replayed onto another.
 */
export function signedBytes(input: {
  readonly determination: unknown;
  readonly recommendationSeq: number | null;
  readonly caseId: string;
}): Buffer {
  return Buffer.from(
    canonicalJson({
      determination: input.determination,
      recommendationSeq: input.recommendationSeq,
      runId: input.caseId,
    }),
    'utf8',
  );
}

/**
 * The bytes a reviewer signs to act on an appeal (P3-F):
 * `canonicalJson({ action, appealId, body, runId })`, with the case id as
 * `runId` as above.
 *
 * The keys differ from a determination's, so a signature over an initial
 * determination never verifies as a reconsideration, and the reverse. The
 * action inside them stops a dismissal's signature being presented as a
 * reconsideration. The appeal id stops a signature being moved to another
 * appeal on the same case, which a dismissal makes possible: a case can have
 * a dismissed appeal and a new one.
 */
export function appealSignedBytes(input: {
  readonly action: 'reconsideration' | 'dismissal';
  readonly appealId: string;
  readonly caseId: string;
  readonly body: unknown;
}): Buffer {
  return Buffer.from(
    canonicalJson({
      action: input.action,
      appealId: input.appealId,
      body: input.body,
      runId: input.caseId,
    }),
    'utf8',
  );
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Whether a string is base64url, unpadded, that decodes to exactly `bytes` bytes. */
export function isBase64UrlOfLength(value: string, bytes: number): boolean {
  return BASE64URL.test(value) && Buffer.from(value, 'base64url').length === bytes;
}

/**
 * An Ed25519 public key from its raw 32 bytes, base64url-encoded, which is
 * the `x` of its JWK and the form the reviewer registry holds.
 */
export function ed25519PublicKey(raw: string): KeyObject {
  if (!isBase64UrlOfLength(raw, ED25519_PUBLIC_KEY_BYTES)) {
    throw new Error('an Ed25519 public key is 32 bytes, base64url-encoded without padding');
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

/**
 * Whether `signature`, base64url, is a valid Ed25519 signature of `bytes`
 * under `publicKey`. A signature that is not 64 bytes of base64url is not
 * valid; nothing here throws on attacker-chosen input.
 */
export function verifySignature(publicKey: KeyObject, bytes: Buffer, signature: string): boolean {
  if (!isBase64UrlOfLength(signature, ED25519_SIGNATURE_BYTES)) return false;
  try {
    return verify(null, bytes, publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
