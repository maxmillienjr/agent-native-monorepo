import { z } from 'zod';
import {
  AdverseDeterminationRecordSchema,
  AgentDispositionSchema,
  ClinicianApprovalSchema,
} from '@repo/determination';

/**
 * The ledger's vocabulary (P3-C): five kinds of entry, and the rows that hold
 * them.
 *
 * Every payload is strict, so a field nobody declared cannot ride into a
 * commitment, and every payload is validated on append and again by the
 * verifier: a stored payload that no longer parses is tampering, whatever its
 * hash says.
 */

const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A SHA-256 digest, lower-case hex. */
export const Sha256HexSchema = z.string().regex(HEX_32_BYTES, 'a SHA-256 digest in lower-case hex');

/** Unpadded base64url that decodes to exactly `bytes` bytes. */
export function base64UrlOfLength(bytes: number, what: string) {
  return z
    .string()
    .regex(BASE64URL, `${what}: unpadded base64url`)
    .refine((value) => Buffer.from(value, 'base64url').length === bytes, {
      message: `${what}: ${bytes} bytes`,
    });
}

/** An Ed25519 public key as P3-E's registry holds it: the raw 32 bytes, the JWK's `x`. */
export const Ed25519PublicKeySchema = base64UrlOfLength(32, 'an Ed25519 public key');
/** An Ed25519 signature: 64 bytes. */
export const Ed25519SignatureSchema = base64UrlOfLength(64, 'an Ed25519 signature');

const SeqSchema = z.number().int().nonnegative();

/**
 * A run, committed: the digest of its `run_records` row, its decisions in
 * order and every checkpoint's `{ next, values }`, read back after the run
 * finished. The counts are there so a reader of the chain alone can see what
 * the digest covers without the content.
 */
export const RunRecordedPayloadSchema = z
  .object({
    kind: z.literal('run.recorded'),
    runId: z.string().uuid(),
    gitSha: z.string().nullable(),
    outcome: z.string().nullable(),
    decisionCount: z.number().int().nonnegative(),
    checkpointCount: z.number().int().nonnegative(),
    runDigest: Sha256HexSchema,
  })
  .strict();

/** What the agent recommended on a run, citing that run's `run.recorded` entry. */
export const DispositionRecommendedPayloadSchema = z
  .object({
    kind: z.literal('disposition.recommended'),
    runId: z.string().uuid(),
    runEntrySeq: SeqSchema,
    disposition: AgentDispositionSchema,
  })
  .strict();

/**
 * The determinations a clinician signs: an approval or an adverse one. The
 * agent's automated approval is P3-A's third member of `DeterminationRecord`
 * and carries no attestation, so it is not something a reviewer attests.
 * Validated through P3-A's reader schemas, which can check a stored
 * determination and cannot mint one.
 */
export const AttestedDeterminationSchema = z.discriminatedUnion('kind', [
  ClinicianApprovalSchema,
  AdverseDeterminationRecordSchema,
]);

/**
 * A clinician's signed determination, citing the recommendation it followed.
 * The signature is over `attestationBytes`: the determination, the
 * recommendation's seq and the run id, so a signature for one run cannot be
 * replayed onto another.
 */
export const DeterminationAttestedPayloadSchema = z
  .object({
    kind: z.literal('determination.attested'),
    runId: z.string().uuid().nullable(),
    recommendationSeq: SeqSchema.nullable(),
    determination: AttestedDeterminationSchema,
    reviewerKeyId: z.string().min(1),
    signature: Ed25519SignatureSchema,
  })
  .strict();

/** A reviewer's public key, registered so later attestations can be checked against it. */
export const ReviewerKeyRegisteredPayloadSchema = z
  .object({
    kind: z.literal('reviewer-key.registered'),
    reviewerKeyId: z.string().min(1),
    reviewerId: z.string().min(1),
    credential: z.object({ type: z.string().min(1), jurisdiction: z.string().min(1) }).strict(),
    publicKey: Ed25519PublicKeySchema,
  })
  .strict();

/** A key that signs nothing from this entry on. Earlier signatures stand. */
export const ReviewerKeyRevokedPayloadSchema = z
  .object({
    kind: z.literal('reviewer-key.revoked'),
    reviewerKeyId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const LedgerPayloadSchema = z.discriminatedUnion('kind', [
  RunRecordedPayloadSchema,
  DispositionRecommendedPayloadSchema,
  DeterminationAttestedPayloadSchema,
  ReviewerKeyRegisteredPayloadSchema,
  ReviewerKeyRevokedPayloadSchema,
]);

export type LedgerPayload = z.infer<typeof LedgerPayloadSchema>;
export type LedgerKind = LedgerPayload['kind'];
export type RunRecordedPayload = z.infer<typeof RunRecordedPayloadSchema>;
export type DispositionRecommendedPayload = z.infer<typeof DispositionRecommendedPayloadSchema>;
export type DeterminationAttestedPayload = z.infer<typeof DeterminationAttestedPayloadSchema>;
export type ReviewerKeyRegisteredPayload = z.infer<typeof ReviewerKeyRegisteredPayloadSchema>;
export type ReviewerKeyRevokedPayload = z.infer<typeof ReviewerKeyRevokedPayloadSchema>;
export type AttestedDetermination = z.infer<typeof AttestedDeterminationSchema>;

export const LEDGER_KINDS = [
  'run.recorded',
  'disposition.recommended',
  'determination.attested',
  'reviewer-key.registered',
  'reviewer-key.revoked',
] as const satisfies readonly LedgerKind[];

/**
 * One `ledger_entries` row, in the form the verifier and an export use: hashes
 * as lower-case hex, the time as ISO-8601. Parsed, not cast, at every boundary.
 */
export const LedgerEntrySchema = z
  .object({
    seq: SeqSchema,
    entryId: z.string().uuid(),
    kind: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
    prevHash: Sha256HexSchema,
    commitment: Sha256HexSchema,
    entryHash: Sha256HexSchema,
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** One `ledger_payloads` row: the salt as hex, and the exact text that was hashed. */
export const LedgerPayloadRowSchema = z
  .object({
    entryId: z.string().uuid(),
    salt: z.string().regex(/^[0-9a-f]{32}$/, 'a 16-byte salt in lower-case hex'),
    payload: z.string(),
  })
  .strict();
export type LedgerPayloadRow = z.infer<typeof LedgerPayloadRowSchema>;

/** One `ledger_anchors` row: the DER response, base64. */
export const LedgerAnchorSchema = z
  .object({
    seq: SeqSchema,
    tsaUrl: z.string().min(1),
    token: z.string().min(1),
    anchoredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type LedgerAnchor = z.infer<typeof LedgerAnchorSchema>;

/** The whole ledger as rows, which is what `verifyChain` reads and an export holds. */
export interface LedgerRows {
  readonly entries: readonly LedgerEntry[];
  readonly payloads: readonly LedgerPayloadRow[];
  readonly anchors: readonly LedgerAnchor[];
}

/** An entry with its payload, as an append returns it. */
export interface StoredEntry {
  readonly entry: LedgerEntry;
  readonly payload: LedgerPayload;
}
