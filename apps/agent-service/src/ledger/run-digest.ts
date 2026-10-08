import { createHash } from 'node:crypto';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { canonicalJson } from '@repo/agent-cassette';
import type { RunRecordRepository, StoredRun } from '@repo/memory-core';
import { recordedHistory, type Snapshot } from '../audit/replay-run.js';

/**
 * A run, as the ledger commits to it (P3-C): SHA-256 over the canonical JSON
 * of its `run_records` row, its `run_decisions` in order, and the
 * `{ next, values }` of every checkpoint in its history, read back from
 * Postgres after the run finished — so the digest is of what was stored, not
 * of what the service meant to store.
 *
 * Here and not in `@repo/decision-ledger`, which must not learn what a
 * checkpoint is. A change to anything below changes every digest already in a
 * ledger, so the object carries a version.
 */
export const RUN_DIGEST_VERSION = 1;

export interface RunDigest {
  readonly runDigest: string;
  readonly decisionCount: number;
  readonly checkpointCount: number;
  readonly gitSha: string | null;
  readonly outcome: string | null;
}

export function digestRun(stored: StoredRun, history: readonly Snapshot[]): RunDigest {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        v: RUN_DIGEST_VERSION,
        record: stored.record,
        decisions: stored.decisions,
        checkpoints: history.map((snapshot) => ({ next: snapshot.next, values: snapshot.values })),
      }),
      'utf8',
    )
    .digest('hex');

  return {
    runDigest: digest,
    decisionCount: stored.decisions.length,
    checkpointCount: history.length,
    gitSha: stored.record.gitSha,
    outcome: stored.record.outcome,
  };
}

/** Reads a run back and digests it, or `null` when it has no record. */
export async function readRunDigest(
  runId: string,
  records: RunRecordRepository,
  checkpointer: BaseCheckpointSaver,
): Promise<RunDigest | null> {
  const stored = await records.read(runId);
  if (stored === null) return null;
  return digestRun(stored, await recordedHistory(stored, checkpointer));
}
