import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

/**
 * The two hashes (P3-C).
 *
 * ```
 * commitment = SHA-256( salt ‖ payload )            -- salt: 16 random bytes
 * entry_hash = SHA-256( canonicalJson({ v: 1, seq, entryId, kind, recordedAt,
 *                                       prevHash: hex, commitment: hex }) )
 * ```
 *
 * Salted, not keyed. A hash of short content can be reversed by enumerating
 * candidates; a per-entry random salt of at least 128 bits stops that (RFC 9901
 * §9.3), so the chain rows, the head and the anchors can leave the database
 * without disclosing what they commit to. An HMAC under a deployment key would
 * too, but losing the key would make every commitment unverifiable and leaking
 * it would make every one enumerable at once. A salt lives beside its payload
 * and is withheld with it.
 */

/** The entry-hash format. A new field in the hashed object is a new version. */
export const ENTRY_HASH_VERSION = 1;

export const SALT_BYTES = 16;

/** `prev_hash` of the entry at seq 0. */
export const GENESIS_PREV_HASH = '0'.repeat(64);

export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/** SHA-256 over the salt and the payload's UTF-8 bytes, as hex. */
export function commitmentOf(salt: Buffer, payload: string): string {
  if (salt.length !== SALT_BYTES) throw new RangeError(`a salt is ${SALT_BYTES} bytes`);
  return createHash('sha256').update(salt).update(payload, 'utf8').digest('hex');
}

/** The fields of an entry the chain hash covers: everything but the hash itself. */
export interface HashedEntryFields {
  readonly seq: number;
  readonly entryId: string;
  readonly kind: string;
  readonly recordedAt: string;
  readonly prevHash: string;
  readonly commitment: string;
}

export function entryHashOf(fields: HashedEntryFields): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        v: ENTRY_HASH_VERSION,
        seq: fields.seq,
        entryId: fields.entryId,
        kind: fields.kind,
        recordedAt: fields.recordedAt,
        prevHash: fields.prevHash,
        commitment: fields.commitment,
      }),
      'utf8',
    )
    .digest('hex');
}

/** The exact text a payload is stored and hashed as. */
export function payloadText(payload: unknown): string {
  return canonicalJson(payload);
}
