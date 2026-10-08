import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

/**
 * What a reviewer signs, and the check the ledger makes, on append and again
 * in the verifier.
 *
 * The bytes are `canonicalJson({ determination, recommendationSeq, runId })`.
 * P3-E's review route verifies the same bytes, with the case id as `runId`,
 * so one signature serves both. The run id inside them stops a signature for
 * one run being replayed onto another; the recommendation's seq stops one
 * being moved onto a different recommendation of the same run.
 */
export function attestationBytes(input: {
  readonly determination: unknown;
  readonly recommendationSeq: number | null;
  readonly runId: string | null;
}): Buffer {
  return Buffer.from(
    canonicalJson({
      determination: input.determination,
      recommendationSeq: input.recommendationSeq,
      runId: input.runId,
    }),
    'utf8',
  );
}

/**
 * Whether `signature` (64 bytes, base64url) is an Ed25519 signature of
 * `bytes` under `publicKey` (the raw 32 bytes, base64url). Never throws on
 * malformed input: a key or signature that does not decode is not valid.
 */
export function verifyEd25519(publicKey: string, bytes: Buffer, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    });
    const raw = Buffer.from(signature, 'base64url');
    if (raw.length !== 64) return false;
    return verify(null, bytes, key, raw);
  } catch {
    return false;
  }
}

/**
 * The namespace every derived entry id is minted in: a random v4, drawn once.
 * It names this ledger's ids and nothing else.
 */
export const LEDGER_NAMESPACE = 'dabfa8a6-258e-444d-85a3-009f007fb7a6';

/**
 * RFC 9562 §5.5: a name-based UUID, SHA-1, version 5. Deriving an entry's id
 * from what it is about — `runId + "\nrun"`, `caseId + "\ndetermination"` —
 * makes a retried append find the entry its first attempt wrote, which is the
 * ledger's idempotency (`append` returns it when the payload matches and
 * throws when it does not).
 */
export function uuidV5(name: string, namespace: string = LEDGER_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new RangeError('a UUID namespace is 16 bytes');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
