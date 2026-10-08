import type { LedgerPayload, ReviewerKeyRegisteredPayload } from './entry.js';
import { attestationBytes, verifyEd25519 } from './signature.js';

/**
 * What may follow what in the chain. One set of rules, applied on append —
 * where a breach is refused before anything is written — and again by the
 * verifier, where a breach in a stored chain is tampering. The two cannot
 * disagree because they are the same code.
 */

/** Why an entry cannot follow the chain: a bad signature, or a reference to the wrong thing. */
export interface RuleBreach {
  readonly check: 'signature' | 'reference';
  readonly reason: string;
}

interface KeyState {
  readonly registration: ReviewerKeyRegisteredPayload;
  readonly registeredAt: number;
  revokedAt: number | null;
}

/**
 * The chain folded so far: the reviewer keys and their state, which run is
 * recorded where, and which recommendation each run carries.
 *
 * Built from entries whose payloads are present. A withheld payload's kind is
 * still known from its row, so a reference to it can be checked for kind,
 * though not for content.
 */
export class ChainState {
  private readonly kinds = new Map<number, string>();
  private readonly keys = new Map<string, KeyState>();
  private readonly runEntries = new Map<string, number>();
  private readonly runOfSeq = new Map<number, string>();
  private readonly recommendations = new Map<string, number>();

  /** Records an entry whose payload is withheld: its kind, and nothing else. */
  applyWithheld(seq: number, kind: string): void {
    this.kinds.set(seq, kind);
  }

  apply(seq: number, payload: LedgerPayload): void {
    this.kinds.set(seq, payload.kind);
    switch (payload.kind) {
      case 'run.recorded':
        this.runEntries.set(payload.runId, seq);
        this.runOfSeq.set(seq, payload.runId);
        return;
      case 'disposition.recommended':
        this.recommendations.set(payload.runId, seq);
        this.runOfSeq.set(seq, payload.runId);
        return;
      case 'reviewer-key.registered':
        this.keys.set(payload.reviewerKeyId, {
          registration: payload,
          registeredAt: seq,
          revokedAt: null,
        });
        return;
      case 'reviewer-key.revoked': {
        const key = this.keys.get(payload.reviewerKeyId);
        if (key !== undefined) key.revokedAt = seq;
        return;
      }
      case 'determination.attested':
        return;
    }
  }

  /** The seq of the run's `run.recorded` entry, if any. */
  runEntry(runId: string): number | undefined {
    return this.runEntries.get(runId);
  }

  /** The seq of the run's `disposition.recommended` entry, if any. */
  recommendation(runId: string): number | undefined {
    return this.recommendations.get(runId);
  }

  /**
   * Whether `payload` may be appended after everything applied so far.
   *
   * `raw` is the payload as it will be stored, before any Zod transform: a
   * signature is checked over the bytes the reviewer signed, and a parse that
   * trimmed a string would check different ones.
   */
  admit(payload: LedgerPayload, raw: unknown): RuleBreach | null {
    switch (payload.kind) {
      case 'run.recorded': {
        const existing = this.runEntries.get(payload.runId);
        return existing === undefined
          ? null
          : reference(`run ${payload.runId} is already recorded at seq ${existing}`);
      }

      case 'disposition.recommended': {
        const kind = this.kinds.get(payload.runEntrySeq);
        if (kind !== 'run.recorded') {
          return reference(
            `runEntrySeq ${payload.runEntrySeq} is ${kind === undefined ? 'not an earlier entry' : `a ${kind} entry`}, not run.recorded`,
          );
        }
        const run = this.runOfSeq.get(payload.runEntrySeq);
        if (run !== undefined && run !== payload.runId) {
          return reference(
            `runEntrySeq ${payload.runEntrySeq} records run ${run}, not ${payload.runId}`,
          );
        }
        const existing = this.recommendations.get(payload.runId);
        return existing === undefined
          ? null
          : reference(`run ${payload.runId} already carries a recommendation at seq ${existing}`);
      }

      case 'determination.attested':
        return this.admitAttestation(payload, raw);

      case 'reviewer-key.registered': {
        const existing = this.keys.get(payload.reviewerKeyId);
        return existing === undefined
          ? null
          : reference(
              `key ${payload.reviewerKeyId} is already registered at seq ${existing.registeredAt}`,
            );
      }

      case 'reviewer-key.revoked': {
        const key = this.keys.get(payload.reviewerKeyId);
        if (key === undefined) return reference(`key ${payload.reviewerKeyId} is not registered`);
        return key.revokedAt === null
          ? null
          : reference(`key ${payload.reviewerKeyId} is already revoked at seq ${key.revokedAt}`);
      }
    }
  }

  private admitAttestation(
    payload: Extract<LedgerPayload, { kind: 'determination.attested' }>,
    raw: unknown,
  ): RuleBreach | null {
    const key = this.keys.get(payload.reviewerKeyId);
    if (key === undefined) {
      return signature(`key ${payload.reviewerKeyId} is not registered earlier in the chain`);
    }
    if (key.revokedAt !== null) {
      return signature(`key ${payload.reviewerKeyId} was revoked at seq ${key.revokedAt}`);
    }

    const signed = raw as { determination?: unknown };
    const bytes = attestationBytes({
      determination: signed.determination,
      recommendationSeq: payload.recommendationSeq,
      runId: payload.runId,
    });
    if (!verifyEd25519(key.registration.publicKey, bytes, payload.signature)) {
      return signature(`the signature does not verify under key ${payload.reviewerKeyId}`);
    }

    // A key binds to one reviewer and one credential. A signature by a valid
    // key over an attestation naming someone else is not that reviewer's.
    const attestation = payload.determination.attestation;
    if (attestation.reviewerId !== key.registration.reviewerId) {
      return signature(
        `the attestation names reviewer ${attestation.reviewerId}; key ${payload.reviewerKeyId} is ${key.registration.reviewerId}'s`,
      );
    }
    if (
      attestation.credential.type !== key.registration.credential.type ||
      attestation.credential.jurisdiction !== key.registration.credential.jurisdiction
    ) {
      return signature(
        `the attestation's credential is not the one key ${payload.reviewerKeyId} was registered with`,
      );
    }

    // P3-A's decision made mechanical: a determination on a run that carries a
    // recommendation must cite it.
    if (payload.runId !== null) {
      const recommended = this.recommendations.get(payload.runId);
      if (recommended !== undefined && payload.recommendationSeq !== recommended) {
        return reference(
          `run ${payload.runId} carries the recommendation at seq ${recommended}, and the determination cites ${payload.recommendationSeq === null ? 'none' : `seq ${payload.recommendationSeq}`}`,
        );
      }
    }
    if (payload.recommendationSeq !== null) {
      const kind = this.kinds.get(payload.recommendationSeq);
      if (kind !== 'disposition.recommended') {
        return reference(
          `recommendationSeq ${payload.recommendationSeq} is ${kind === undefined ? 'not an earlier entry' : `a ${kind} entry`}, not disposition.recommended`,
        );
      }
      const run = this.runOfSeq.get(payload.recommendationSeq);
      if (run !== undefined && run !== payload.runId) {
        return reference(
          `recommendationSeq ${payload.recommendationSeq} is run ${run}'s, not ${String(payload.runId)}'s`,
        );
      }
    }
    return null;
  }
}

function signature(reason: string): RuleBreach {
  return { check: 'signature', reason };
}

function reference(reason: string): RuleBreach {
  return { check: 'reference', reason };
}
