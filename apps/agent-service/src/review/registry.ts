import { readFileSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { ed25519PublicKey, isBase64UrlOfLength } from './signature.js';

/** The variable that names the reviewer registry file. */
export const REVIEWER_REGISTRY_ENV = 'REVIEWER_REGISTRY';

/** Injection token for the loaded registry, or `null` when none is configured. */
export const REVIEWER_REGISTRY = 'REVIEWER_REGISTRY';

/**
 * One reviewer key. `reviewerId` and `credential` are what the key's holder
 * is registered as; an attestation signed with the key must claim exactly
 * them. `principal`, when present, is the authenticated caller the key may be
 * used by once P5-A enforces authentication. `revokedAt` retires the key.
 *
 * With a ledger configured (P3-C), each entry would be appended as a
 * `reviewer-key.registered` entry and the ledger's registrations and
 * revocations become authoritative. Until then this file is.
 */
export const ReviewerRegistryEntrySchema = z
  .object({
    reviewerKeyId: z.string().min(1),
    reviewerId: z.string().min(1),
    credential: z.object({ type: z.string().min(1), jurisdiction: z.string().min(1) }).strict(),
    /** The raw 32-byte Ed25519 public key, base64url without padding. */
    publicKey: z.string().refine((value) => isBase64UrlOfLength(value, 32), {
      message: 'an Ed25519 public key is 32 bytes, base64url-encoded without padding',
    }),
    principal: z.string().min(1).optional(),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type ReviewerRegistryEntry = z.infer<typeof ReviewerRegistryEntrySchema>;

export const ReviewerRegistrySchema = z
  .array(ReviewerRegistryEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.reviewerKeyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'reviewerKeyId'],
          message: `reviewerKeyId ${entry.reviewerKeyId} is registered twice`,
        });
      }
      seen.add(entry.reviewerKeyId);
    }
  });

/** A registered key, ready to verify with. */
export interface RegisteredKey {
  readonly entry: ReviewerRegistryEntry;
  readonly publicKey: KeyObject;
}

/** The public keys the service verifies determinations against. It holds no private key. */
export class ReviewerRegistry {
  private readonly keys: ReadonlyMap<string, RegisteredKey>;

  constructor(entries: readonly ReviewerRegistryEntry[]) {
    this.keys = new Map(
      ReviewerRegistrySchema.parse(entries).map((entry) => [
        entry.reviewerKeyId,
        { entry, publicKey: ed25519PublicKey(entry.publicKey) },
      ]),
    );
  }

  /** The key, if it is registered and was not revoked at or before `at`. */
  active(reviewerKeyId: string, at: Date): RegisteredKey | undefined {
    const key = this.keys.get(reviewerKeyId);
    if (key === undefined) return undefined;
    const revokedAt = key.entry.revokedAt;
    if (revokedAt !== undefined && Date.parse(revokedAt) <= at.getTime()) return undefined;
    return key;
  }

  get size(): number {
    return this.keys.size;
  }
}

/**
 * Reads `REVIEWER_REGISTRY`, following the axis rule. Unset, there is no
 * registry, and the determination route answers 503 while the read routes
 * still serve. Set and unreadable or malformed, this throws an error that
 * names the variable, and boot exits 1 with it.
 */
export function loadReviewerRegistry(
  env: NodeJS.ProcessEnv = process.env,
): ReviewerRegistry | null {
  const path = env[REVIEWER_REGISTRY_ENV];
  if (path === undefined || path.trim() === '') return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${REVIEWER_REGISTRY_ENV} names ${path}, which could not be read as JSON: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const parsed = ReviewerRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `${REVIEWER_REGISTRY_ENV} names ${path}, which is not a reviewer registry: ${problems}`,
    );
  }
  return new ReviewerRegistry(parsed.data);
}
