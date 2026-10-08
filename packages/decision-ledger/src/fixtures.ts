import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type {
  AttestedDetermination,
  DeterminationAttestedPayload,
  LedgerEntry,
  LedgerPayload,
  LedgerPayloadRow,
  LedgerRows,
  ReviewerKeyRegisteredPayload,
} from './entry.js';
import { GENESIS_PREV_HASH, commitmentOf, entryHashOf, newSalt, payloadText } from './hash.js';
import { attestationBytes } from './signature.js';

/**
 * Test fixtures. Every reviewer, key and run here is synthetic: the reviewer
 * ids say so, the keys are generated in-process for each test and never
 * written anywhere, and no identifier names a real person or licence.
 *
 * Not exported from the barrel.
 */

export interface SyntheticReviewer {
  readonly reviewerKeyId: string;
  readonly reviewerId: string;
  readonly credential: { readonly type: string; readonly jurisdiction: string };
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

export function syntheticReviewer(n = 1): SyntheticReviewer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('an Ed25519 JWK has an x');
  return {
    reviewerKeyId: `synthetic-key-${String(n).padStart(3, '0')}`,
    reviewerId: `synthetic-reviewer-${String(n).padStart(3, '0')}`,
    credential: { type: 'MD', jurisdiction: 'US-SYNTHETIC' },
    publicKey: jwk.x,
    privateKey,
  };
}

export function registration(reviewer: SyntheticReviewer): ReviewerKeyRegisteredPayload {
  return {
    kind: 'reviewer-key.registered',
    reviewerKeyId: reviewer.reviewerKeyId,
    reviewerId: reviewer.reviewerId,
    credential: { ...reviewer.credential },
    publicKey: reviewer.publicKey,
  };
}

export function syntheticDenial(reviewer: SyntheticReviewer): AttestedDetermination {
  return {
    kind: 'denial',
    specificReason: 'Synthetic fixture: the record does not document the policy criterion.',
    attestation: {
      reviewerId: reviewer.reviewerId,
      credential: { ...reviewer.credential },
      attestedAt: '2026-10-08T12:00:00.000Z',
    },
  };
}

/** A determination signed by `signer`, over the bytes the ledger checks. */
export function attestation(input: {
  readonly signer: SyntheticReviewer;
  readonly runId: string | null;
  readonly recommendationSeq: number | null;
  readonly determination?: AttestedDetermination;
  /** Claim this key id instead of the signer's. */
  readonly reviewerKeyId?: string;
}): DeterminationAttestedPayload {
  const determination = input.determination ?? syntheticDenial(input.signer);
  const bytes = attestationBytes({
    determination,
    recommendationSeq: input.recommendationSeq,
    runId: input.runId,
  });
  return {
    kind: 'determination.attested',
    runId: input.runId,
    recommendationSeq: input.recommendationSeq,
    determination,
    reviewerKeyId: input.reviewerKeyId ?? input.signer.reviewerKeyId,
    signature: sign(null, bytes, input.signer.privateKey).toString('base64url'),
  };
}

export const SYNTHETIC_RUN = '00000000-0000-4000-8000-00000000c0de';

export function runRecorded(runId: string = SYNTHETIC_RUN): LedgerPayload {
  return {
    kind: 'run.recorded',
    runId,
    gitSha: null,
    outcome: 'success',
    decisionCount: 1,
    checkpointCount: 3,
    runDigest: 'ab'.repeat(32),
  };
}

export function recommended(runEntrySeq: number, runId: string = SYNTHETIC_RUN): LedgerPayload {
  return {
    kind: 'disposition.recommended',
    runId,
    runEntrySeq,
    disposition: {
      kind: 'refer-to-clinician',
      findings: [
        {
          criterionId: 'synthetic-criterion-1',
          status: 'not-met',
          evidence: [],
          rationale: 'Synthetic.',
        },
      ],
    },
  };
}

/**
 * Rows for `payloads`, hashed and linked as a writer with the table to itself
 * would: no rules applied. This is how a test plays a database administrator
 * who rewrites the chain consistently, or plants an entry the append would
 * have refused.
 */
export function forgeRows(
  payloads: readonly LedgerPayload[],
  options: { readonly from?: LedgerRows; readonly entryIds?: readonly string[] } = {},
): LedgerRows {
  const entries: LedgerEntry[] = [...(options.from?.entries ?? [])];
  const rows: LedgerPayloadRow[] = [...(options.from?.payloads ?? [])];
  payloads.forEach((payload, index) => {
    const head = entries.at(-1);
    const salt = newSalt();
    const text = payloadText(payload);
    const fields = {
      seq: head === undefined ? 0 : head.seq + 1,
      entryId: options.entryIds?.[index] ?? randomUUID(),
      kind: payload.kind,
      recordedAt: new Date(Date.UTC(2026, 9, 8, 12, 0, entries.length)).toISOString(),
      prevHash: head === undefined ? GENESIS_PREV_HASH : head.entryHash,
      commitment: commitmentOf(salt, text),
    };
    entries.push({ ...fields, entryHash: entryHashOf(fields) });
    rows.push({ entryId: fields.entryId, salt: salt.toString('hex'), payload: text });
  });
  return { entries, payloads: rows, anchors: [...(options.from?.anchors ?? [])] };
}

/**
 * Re-hashes every entry from `fromSeq` onward, so the chain links again after
 * an edit: the consistent rewrite the threat model's DBA row describes.
 */
export function rehashFrom(rows: LedgerRows, fromSeq: number): LedgerRows {
  const payloads = new Map(rows.payloads.map((row) => [row.entryId, row]));
  const entries: LedgerEntry[] = [];
  for (const entry of [...rows.entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.seq < fromSeq) {
      entries.push(entry);
      continue;
    }
    const previous = entries.at(-1);
    const payload = payloads.get(entry.entryId);
    const fields = {
      ...entry,
      prevHash: previous === undefined ? GENESIS_PREV_HASH : previous.entryHash,
      commitment:
        payload === undefined
          ? entry.commitment
          : commitmentOf(Buffer.from(payload.salt, 'hex'), payload.payload),
    };
    entries.push({ ...fields, entryHash: entryHashOf(fields) });
  }
  return { ...rows, entries };
}
