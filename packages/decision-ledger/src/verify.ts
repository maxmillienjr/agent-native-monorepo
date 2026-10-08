import { LedgerPayloadSchema, type LedgerPayload, type LedgerRows } from './entry.js';
import { GENESIS_PREV_HASH, commitmentOf, entryHashOf } from './hash.js';
import { ChainState } from './rules.js';

/**
 * `verifyChain`: checks 1-4 of the PRD's seven, over rows alone. Pure — no
 * database, no clock, no network — so an auditor can run it over an export
 * without the service. Check 5, the anchors, shells out to OpenSSL and is
 * `verifyAnchors`; checks 6 and 7 need the run records and are the service's.
 *
 * 1. `seq` is contiguous from 0, and each `prev_hash` is the previous `entry_hash`.
 * 2. Each `entry_hash` recomputes from its row.
 * 3. Each present payload recomputes to its `commitment`, parses, and has its
 *    row's kind; an absent one is counted as withheld.
 * 4. Each attestation's signature verifies under a key registered before it
 *    and not revoked, and every reference names the right kind of entry.
 *
 * It stops at the first failure and names its seq: everything after a broken
 * link is unverifiable, and the first break is where an investigation starts.
 */

export type ChainCheck =
  | 'sequence'
  | 'link'
  | 'entry-hash'
  | 'commitment'
  | 'payload'
  | 'signature'
  | 'reference'
  | 'anchor';

export interface ChainFailure {
  readonly seq: number;
  readonly check: ChainCheck;
  readonly reason: string;
}

export interface ChainReport {
  readonly ok: boolean;
  readonly entries: number;
  /** The last entry checked: the head when `ok`. */
  readonly head: { readonly seq: number; readonly entryHash: string } | null;
  /** Seqs whose payload has been deleted under a retention policy. Not a failure. */
  readonly withheld: readonly number[];
  /** Entries by kind, over the payloads present. */
  readonly kinds: Readonly<Record<string, number>>;
  /** The first failure, when not `ok`. */
  readonly failure?: ChainFailure;
}

/** Each entry with its parsed payload, for a caller that checks further (run digests). */
export interface VerifiedEntry {
  readonly seq: number;
  readonly entryHash: string;
  readonly payload: LedgerPayload | null;
}

export function verifyChain(
  rows: LedgerRows,
): ChainReport & { readonly verified: readonly VerifiedEntry[] } {
  const entries = [...rows.entries].sort((a, b) => a.seq - b.seq);
  const payloads = new Map(rows.payloads.map((row) => [row.entryId, row]));
  const state = new ChainState();
  const withheld: number[] = [];
  const kinds: Record<string, number> = {};
  const verified: VerifiedEntry[] = [];

  let previous: { seq: number; entryHash: string } | null = null;

  const report = (failure?: ChainFailure) => ({
    ok: failure === undefined,
    entries: entries.length,
    head: previous,
    withheld,
    kinds,
    verified,
    ...(failure === undefined ? {} : { failure }),
  });

  for (const [index, entry] of entries.entries()) {
    // 1. Contiguity and the link.
    if (entry.seq !== index) {
      return report({
        seq: index,
        check: 'sequence',
        reason:
          entry.seq > index
            ? `seq ${index} is missing: the entry after seq ${index - 1} is seq ${entry.seq}`
            : `seq ${entry.seq} appears twice`,
      });
    }
    const expectedPrev = previous === null ? GENESIS_PREV_HASH : previous.entryHash;
    if (entry.prevHash !== expectedPrev) {
      return report({
        seq: entry.seq,
        check: 'link',
        reason: `prev_hash is ${short(entry.prevHash)}; ${previous === null ? 'the genesis entry links to 32 zero bytes' : `seq ${previous.seq}'s entry_hash is ${short(previous.entryHash)}`}`,
      });
    }

    // 2. The row's own hash.
    const recomputed = entryHashOf(entry);
    if (recomputed !== entry.entryHash) {
      return report({
        seq: entry.seq,
        check: 'entry-hash',
        reason: `entry_hash is ${short(entry.entryHash)}; the row hashes to ${short(recomputed)}`,
      });
    }

    // 3. The commitment, and the payload behind it.
    const stored = payloads.get(entry.entryId);
    let payload: LedgerPayload | null = null;
    if (stored === undefined) {
      withheld.push(entry.seq);
      state.applyWithheld(entry.seq, entry.kind);
    } else {
      const commitment = commitmentOf(Buffer.from(stored.salt, 'hex'), stored.payload);
      if (commitment !== entry.commitment) {
        return report({
          seq: entry.seq,
          check: 'commitment',
          reason: `the payload hashes to ${short(commitment)}; the entry commits to ${short(entry.commitment)}`,
        });
      }

      let raw: unknown;
      try {
        raw = JSON.parse(stored.payload);
      } catch {
        return report({ seq: entry.seq, check: 'payload', reason: 'the payload is not JSON' });
      }
      const parsed = LedgerPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return report({
          seq: entry.seq,
          check: 'payload',
          reason: `the payload is not a ledger payload: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        });
      }
      if (parsed.data.kind !== entry.kind) {
        return report({
          seq: entry.seq,
          check: 'payload',
          reason: `the row says ${entry.kind} and the payload ${parsed.data.kind}`,
        });
      }

      // 4. Signatures and references, by the rules an append is held to.
      const breach = state.admit(parsed.data, raw);
      if (breach !== null) return report({ seq: entry.seq, ...breach });
      state.apply(entry.seq, parsed.data);
      payload = parsed.data;
      kinds[payload.kind] = (kinds[payload.kind] ?? 0) + 1;
    }

    verified.push({ seq: entry.seq, entryHash: entry.entryHash, payload });
    previous = { seq: entry.seq, entryHash: entry.entryHash };
  }

  return report();
}

function short(hex: string): string {
  return `${hex.slice(0, 12)}…`;
}
