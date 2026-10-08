import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { AgentDisposition } from '@repo/determination';
import {
  uuidV5,
  type Ledger,
  type StoredEntry,
  type DeterminationAttestedPayload,
} from '@repo/decision-ledger';
import type { RunRecordRepository } from '@repo/memory-core';
import { createLogger } from '@repo/telemetry';
import { readRunDigest } from './run-digest.js';

const logger = createLogger('ledger');

/**
 * The service's side of the ledger (P3-C): what it appends, and with which
 * derived entry id.
 *
 * Every entry id is a name-based UUID of what the entry is about —
 * `runId + "\nrun"`, `runId + "\ndisposition"`, `caseId + "\ndetermination"` —
 * so a retry of any of these finds the entry its first attempt wrote, and a
 * different payload for the same thing throws rather than appending twice.
 *
 * Constructed only outside `src/agent/`: the lint rule keeps the ledger out
 * of the graph, as P3-A keeps the clinician constructor out. The agent cannot
 * write the ledger, and never reads it.
 */
export class RunLedger {
  constructor(
    private readonly ledger: Ledger,
    private readonly records: RunRecordRepository,
    private readonly checkpointer: BaseCheckpointSaver,
  ) {}

  /**
   * Appends `run.recorded` for a finished run, or returns `null` when the run
   * left no record (its record could not be opened, so it did no work).
   */
  async commitRun(runId: string): Promise<StoredEntry | null> {
    const digest = await readRunDigest(runId, this.records, this.checkpointer);
    if (digest === null) return null;
    return this.ledger.append({
      entryId: uuidV5(`${runId}\nrun`),
      payload: { kind: 'run.recorded', runId, ...digest },
    });
  }

  /**
   * `commitRun`, failing open: the chat path's half of the split decided at
   * review. A failed append is logged and the run's response stands;
   * `ledger:verify` lists the run as uncommitted, so the gap is visible.
   */
  async commitRunOrLog(runId: string, correlationId: string): Promise<void> {
    try {
      await this.commitRun(runId);
    } catch (error) {
      logger.error({
        msg: 'ledger.append_failed',
        correlationId,
        runId,
        kind: 'run.recorded',
        errorType: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Appends what the agent recommended on a run, citing the run's own entry. */
  recommend(
    runId: string,
    runEntrySeq: number,
    disposition: AgentDisposition,
  ): Promise<StoredEntry> {
    return this.ledger.append({
      entryId: uuidV5(`${runId}\ndisposition`),
      payload: { kind: 'disposition.recommended', runId, runEntrySeq, disposition },
    });
  }

  /**
   * Registers each reviewer key the ledger does not hold yet, and revokes
   * each one the registry marks revoked. Idempotent through the derived ids;
   * a key whose registry entry no longer matches its registration throws,
   * because the ledger, not the file, is authoritative once it holds a key.
   */
  async registerKeys(
    entries: readonly {
      readonly reviewerKeyId: string;
      readonly reviewerId: string;
      readonly credential: { readonly type: string; readonly jurisdiction: string };
      readonly publicKey: string;
      readonly revokedAt?: string;
    }[],
  ): Promise<{ registered: number; revoked: number }> {
    let revoked = 0;
    for (const entry of entries) {
      await this.ledger.append({
        entryId: uuidV5(`${entry.reviewerKeyId}\nregistered`),
        payload: {
          kind: 'reviewer-key.registered',
          reviewerKeyId: entry.reviewerKeyId,
          reviewerId: entry.reviewerId,
          credential: { type: entry.credential.type, jurisdiction: entry.credential.jurisdiction },
          publicKey: entry.publicKey,
        },
      });
      if (entry.revokedAt !== undefined) {
        await this.ledger.append({
          entryId: uuidV5(`${entry.reviewerKeyId}\nrevoked`),
          payload: {
            kind: 'reviewer-key.revoked',
            reviewerKeyId: entry.reviewerKeyId,
            reason: `Revoked in the reviewer registry at ${entry.revokedAt}.`,
          },
        });
        revoked += 1;
      }
    }
    return { registered: entries.length, revoked };
  }

  /** Appends a clinician's signed determination; refused unless the chain's rules hold. */
  attest(payload: Omit<DeterminationAttestedPayload, 'kind'>): Promise<StoredEntry> {
    return this.ledger.appendAttestation({
      // P3-E's derived id: one determination per case, so a retry after a
      // failed commit finds this entry, and a different one throws.
      entryId: uuidV5(`${payload.runId ?? payload.reviewerKeyId}\ndetermination`),
      payload: { kind: 'determination.attested', ...payload },
    });
  }
}
