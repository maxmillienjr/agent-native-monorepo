import {
  LedgerPayloadSchema,
  type LedgerAnchor,
  type LedgerEntry,
  type LedgerPayload,
  type LedgerPayloadRow,
  type LedgerRows,
  type StoredEntry,
} from './entry.js';
import { GENESIS_PREV_HASH, commitmentOf, entryHashOf, newSalt, payloadText } from './hash.js';
import type { ChainState, RuleBreach } from './rules.js';

/**
 * The append (P3-C). One transaction, serialised: lock, read the head, check
 * the payload against the chain, insert `seq + 1` linked to the head's hash,
 * insert the payload, commit. The store decides how "serialised" is achieved —
 * an advisory lock in Postgres, a promise chain in memory — and the `UNIQUE`
 * constraints on `seq` and `prev_hash` keep the Postgres chain linear even if
 * the lock is bypassed.
 */

/** What an append is refused for: an invalid payload, or one the chain's rules reject. */
export class LedgerRefusedError extends Error {
  constructor(
    readonly check: RuleBreach['check'] | 'payload',
    reason: string,
  ) {
    super(`the ledger refused the entry (${check}): ${reason}`);
    this.name = 'LedgerRefusedError';
  }
}

/** A retried `entryId` whose payload is not the stored one. */
export class LedgerConflictError extends Error {
  constructor(entryId: string, reason: string) {
    super(`entry ${entryId} already exists ${reason}`);
    this.name = 'LedgerConflictError';
  }
}

/** One serialised transaction against the ledger's tables. */
export interface LedgerTransaction {
  head(): Promise<LedgerEntry | null>;
  byEntryId(
    entryId: string,
  ): Promise<{ readonly entry: LedgerEntry; readonly payload: LedgerPayloadRow | null } | null>;
  /**
   * The chain folded far enough to judge `payload`: every reviewer-key entry,
   * the entries about its run, and the entries at the seqs it references.
   */
  stateFor(payload: LedgerPayload): Promise<ChainState>;
  insert(entry: LedgerEntry, payload: LedgerPayloadRow): Promise<void>;
}

export interface LedgerStore {
  transaction<T>(work: (tx: LedgerTransaction) => Promise<T>): Promise<T>;
  readRows(): Promise<LedgerRows>;
  insertAnchor(anchor: LedgerAnchor): Promise<void>;
}

export interface AppendInput {
  /** Caller-supplied, so a retry is idempotent. Derive it with `uuidV5` from what the entry is about. */
  readonly entryId: string;
  readonly payload: LedgerPayload;
  /** Defaults to now. */
  readonly recordedAt?: Date;
}

export class Ledger {
  constructor(
    readonly store: LedgerStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Appends one entry, or returns the stored one when `entryId` is already
   * present with byte-identical payload. Throws `LedgerConflictError` when it
   * is present with another, and `LedgerRefusedError` when the payload is
   * invalid or the chain's rules refuse it — before anything is written.
   */
  async append(input: AppendInput): Promise<StoredEntry> {
    // The payload as it will be stored and hashed, and as the verifier will
    // read it back. Validated in that form, and signatures checked over it,
    // so a Zod transform can never make append and verify disagree.
    const text = payloadText(input.payload);
    const raw: unknown = JSON.parse(text);
    const parsed = LedgerPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LedgerRefusedError(
        'payload',
        `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`,
      );
    }
    const payload = parsed.data;

    return this.store.transaction(async (tx) => {
      const existing = await tx.byEntryId(input.entryId);
      if (existing !== null) {
        if (existing.payload === null) {
          throw new LedgerConflictError(
            input.entryId,
            'and its payload is withheld, so a retry cannot be matched',
          );
        }
        if (existing.payload.payload !== text) {
          throw new LedgerConflictError(
            input.entryId,
            `at seq ${existing.entry.seq} with a different payload`,
          );
        }
        return { entry: existing.entry, payload };
      }

      const state = await tx.stateFor(payload);
      const breach = state.admit(payload, raw);
      if (breach !== null) throw new LedgerRefusedError(breach.check, breach.reason);

      const head = await tx.head();
      const salt = newSalt();
      const fields = {
        seq: head === null ? 0 : head.seq + 1,
        entryId: input.entryId,
        kind: payload.kind,
        recordedAt: (input.recordedAt ?? this.clock()).toISOString(),
        prevHash: head === null ? GENESIS_PREV_HASH : head.entryHash,
        commitment: commitmentOf(salt, text),
      };
      const entry: LedgerEntry = { ...fields, entryHash: entryHashOf(fields) };
      await tx.insert(entry, { entryId: entry.entryId, salt: salt.toString('hex'), payload: text });
      return { entry, payload };
    });
  }

  /**
   * `append`, for a clinician's signed determination only. The rules are the
   * same ones `append` applies; this names the call a review route makes, and
   * refuses any other kind, so a caller that meant to attest cannot append
   * something else by mistake.
   */
  async appendAttestation(input: AppendInput): Promise<StoredEntry> {
    if (input.payload.kind !== 'determination.attested') {
      throw new LedgerRefusedError(
        'payload',
        `appendAttestation takes determination.attested, not ${input.payload.kind}`,
      );
    }
    return this.append(input);
  }

  readRows(): Promise<LedgerRows> {
    return this.store.readRows();
  }
}

/** The seqs a payload refers to, which a store must fold to judge it. */
export function referencedSeqs(payload: LedgerPayload): number[] {
  switch (payload.kind) {
    case 'disposition.recommended':
      return [payload.runEntrySeq];
    case 'determination.attested':
      return payload.recommendationSeq === null ? [] : [payload.recommendationSeq];
    default:
      return [];
  }
}

/** The run a payload is about, whose entries a store must fold to judge it. */
export function runOf(payload: LedgerPayload): string | null {
  switch (payload.kind) {
    case 'run.recorded':
    case 'disposition.recommended':
    case 'determination.attested':
      return payload.runId;
    default:
      return null;
  }
}
