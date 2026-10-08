import type {
  AppealDismissedPayload,
  LedgerPayload,
  ReconsiderationAttestedPayload,
  ReviewerKeyRegisteredPayload,
} from './entry.js';
import { appealActionBytes, attestationBytes, verifyEd25519 } from './signature.js';

/**
 * What may follow what in the chain. One set of rules, applied on append —
 * where a breach is refused before anything is written — and again by the
 * verifier, where a breach in a stored chain is tampering. The two cannot
 * disagree because they are the same code.
 */

/**
 * Why an entry cannot follow the chain: a bad signature, a reference to the
 * wrong thing, or (P3-F) an appeal acted on by the reviewer whose
 * determination it appeals.
 */
export interface RuleBreach {
  readonly check: 'signature' | 'reference' | 'involvement';
  readonly reason: string;
}

interface KeyState {
  readonly registration: ReviewerKeyRegisteredPayload;
  readonly registeredAt: number;
  revokedAt: number | null;
}

/** A clinician's determination, as far as an appeal of it needs to know. */
interface DeterminationState {
  readonly runId: string | null;
  readonly reviewerKeyId: string;
  /** The reviewer the attestation names, which the key's registration matched when it was appended. */
  readonly reviewerId: string;
  readonly adverse: boolean;
}

/** An appeal (P3-F), keyed by its filing's seq. */
interface AppealState {
  readonly appealId: string;
  readonly caseId: string;
  readonly determinationSeq: number;
  outcome: 'reversal' | 'affirmation' | 'dismissed' | null;
  forwarded: boolean;
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
  private readonly determinations = new Map<number, DeterminationState>();
  private readonly appeals = new Map<number, AppealState>();
  private readonly appealSeqs = new Map<string, number>();

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
        this.determinations.set(seq, {
          runId: payload.runId,
          reviewerKeyId: payload.reviewerKeyId,
          reviewerId: payload.determination.attestation.reviewerId,
          adverse: payload.determination.kind !== 'clinician-approval',
        });
        return;
      case 'appeal.filed':
        this.appeals.set(seq, {
          appealId: payload.appealId,
          caseId: payload.caseId,
          determinationSeq: payload.determinationSeq,
          outcome: null,
          forwarded: false,
        });
        this.appealSeqs.set(payload.appealId, seq);
        return;
      case 'reconsideration.attested': {
        const appeal = this.appeals.get(payload.appealSeq);
        if (appeal !== undefined) appeal.outcome = payload.reconsideration.kind;
        return;
      }
      case 'appeal.dismissed': {
        const appeal = this.appeals.get(payload.appealSeq);
        if (appeal !== undefined) appeal.outcome = 'dismissed';
        return;
      }
      case 'appeal.forwarded': {
        const appeal = this.appeals.get(payload.appealSeq);
        if (appeal !== undefined) appeal.forwarded = true;
        return;
      }
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

      case 'appeal.filed': {
        const cited = this.citedDetermination(payload.determinationSeq, payload.caseId);
        if (cited.breach !== null) return cited.breach;
        if (cited.determination !== undefined && !cited.determination.adverse) {
          return reference(
            `determinationSeq ${payload.determinationSeq} is an approval, and only an adverse determination is appealed`,
          );
        }
        const existing = this.appealSeqs.get(payload.appealId);
        return existing === undefined
          ? null
          : reference(`appeal ${payload.appealId} is already filed at seq ${existing}`);
      }

      case 'reconsideration.attested':
      case 'appeal.dismissed':
        return this.admitAppealAction(payload, raw);

      case 'appeal.forwarded': {
        const filed = this.openAppeal(payload);
        if (filed.breach !== null) return filed.breach;
        const appeal = filed.appeal;
        if (appeal === undefined) return null;
        if (appeal.outcome === 'reversal' || appeal.outcome === 'dismissed') {
          return reference(
            `appeal ${payload.appealId} was ${appeal.outcome === 'reversal' ? 'reversed' : 'dismissed'}, so nothing is forwarded`,
          );
        }
        if (payload.reason === 'affirmed' && appeal.outcome !== 'affirmation') {
          return reference(
            `appeal ${payload.appealId} is forwarded as affirmed with no affirmation before it`,
          );
        }
        if (payload.reason === 'deadline-lapsed' && appeal.outcome !== null) {
          return reference(`appeal ${payload.appealId} was reconsidered, so it did not lapse`);
        }
        return null;
      }
    }
  }

  /**
   * The appeal a later entry cites by `appealSeq`, checked against the entry.
   * A withheld filing is checked for kind and nothing else, as a withheld
   * recommendation is. One already forwarded takes nothing further.
   */
  private openAppeal(payload: {
    readonly appealId: string;
    readonly caseId: string;
    readonly appealSeq: number;
    readonly determinationSeq?: number;
  }): { breach: RuleBreach | null; appeal?: AppealState } {
    const kind = this.kinds.get(payload.appealSeq);
    if (kind !== 'appeal.filed') {
      return {
        breach: reference(
          `appealSeq ${payload.appealSeq} is ${kind === undefined ? 'not an earlier entry' : `a ${kind} entry`}, not appeal.filed`,
        ),
      };
    }
    const appeal = this.appeals.get(payload.appealSeq);
    if (appeal === undefined) return { breach: null };
    if (
      appeal.appealId !== payload.appealId ||
      appeal.caseId !== payload.caseId ||
      (payload.determinationSeq !== undefined &&
        appeal.determinationSeq !== payload.determinationSeq)
    ) {
      return {
        breach: reference(
          `appealSeq ${payload.appealSeq} files appeal ${appeal.appealId} on case ${appeal.caseId} against seq ${appeal.determinationSeq}, which this entry does not name`,
        ),
      };
    }
    if (appeal.forwarded) {
      return { breach: reference(`appeal ${payload.appealId} was already forwarded`) };
    }
    return { breach: null, appeal };
  }

  /** The determination an appeal cites: a `determination.attested` entry on the appealed case. */
  private citedDetermination(
    determinationSeq: number,
    caseId: string,
  ): { breach: RuleBreach | null; determination?: DeterminationState } {
    const kind = this.kinds.get(determinationSeq);
    if (kind !== 'determination.attested') {
      return {
        breach: reference(
          `determinationSeq ${determinationSeq} is ${kind === undefined ? 'not an earlier entry' : `a ${kind} entry`}, not determination.attested`,
        ),
      };
    }
    const determination = this.determinations.get(determinationSeq);
    if (determination !== undefined && determination.runId !== caseId) {
      return {
        breach: reference(
          `determinationSeq ${determinationSeq} decides case ${String(determination.runId)}, not ${caseId}`,
        ),
      };
    }
    return { breach: null, determination };
  }

  /**
   * A reconsideration or a dismissal: signed over the appeal's bytes by a key
   * registered and not revoked, naming that key's reviewer and credential, on
   * an appeal filed and not yet decided, and (§ 422.590(h)(1), from the chain
   * alone) by a reviewer who is not the one registered to the key that signed
   * the determination under appeal. The comparison is between the reviewers
   * the two keys were registered to, so a second key held by the reviewer who
   * denied is refused as the first would be.
   */
  private admitAppealAction(
    payload: ReconsiderationAttestedPayload | AppealDismissedPayload,
    raw: unknown,
  ): RuleBreach | null {
    const filed = this.openAppeal(payload);
    if (filed.breach !== null) return filed.breach;
    if (filed.appeal !== undefined && filed.appeal.outcome !== null) {
      return reference(
        `appeal ${payload.appealId} was already ${filed.appeal.outcome === 'dismissed' ? 'dismissed' : 'reconsidered'}`,
      );
    }
    const cited = this.citedDetermination(payload.determinationSeq, payload.caseId);
    if (cited.breach !== null) return cited.breach;

    const key = this.keys.get(payload.reviewerKeyId);
    if (key === undefined) {
      return signature(`key ${payload.reviewerKeyId} is not registered earlier in the chain`);
    }
    if (key.revokedAt !== null) {
      return signature(`key ${payload.reviewerKeyId} was revoked at seq ${key.revokedAt}`);
    }

    const action = payload.kind === 'reconsideration.attested' ? 'reconsideration' : 'dismissal';
    const signed = raw as { reconsideration?: Record<string, unknown>; dismissal?: unknown };
    let body: unknown = signed.dismissal;
    if (action === 'reconsideration') {
      // The physician signed the reconsideration without the initial
      // reviewer, which the service adds from the case.
      const { initialReviewerId: _added, ...reconsideration } = signed.reconsideration ?? {};
      body = reconsideration;
    }
    const bytes = appealActionBytes({
      action,
      appealId: payload.appealId,
      caseId: payload.caseId,
      body,
    });
    if (!verifyEd25519(key.registration.publicKey, bytes, payload.signature)) {
      return signature(`the signature does not verify under key ${payload.reviewerKeyId}`);
    }

    const attestation =
      payload.kind === 'reconsideration.attested'
        ? payload.reconsideration.attestation
        : payload.dismissal.attestation;
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

    const determination = cited.determination;
    if (determination === undefined) return null;
    const deniedBy =
      this.keys.get(determination.reviewerKeyId)?.registration.reviewerId ??
      determination.reviewerId;
    if (key.registration.reviewerId === deniedBy) {
      return {
        check: 'involvement',
        reason:
          `key ${payload.reviewerKeyId} is ${deniedBy}'s, who made the determination at seq ` +
          `${payload.determinationSeq}; a reconsideration is made by someone not involved in it`,
      };
    }
    if (
      payload.kind === 'reconsideration.attested' &&
      payload.reconsideration.initialReviewerId !== determination.reviewerId
    ) {
      return reference(
        `the reconsideration names ${payload.reconsideration.initialReviewerId} as the initial reviewer; seq ${payload.determinationSeq} was attested by ${determination.reviewerId}`,
      );
    }
    return null;
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
