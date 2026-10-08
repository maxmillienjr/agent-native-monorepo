import type { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  verifyAnchors,
  verifyChain,
  type ChainReport,
  type LedgerRows,
} from '@repo/decision-ledger';
import type { RunRecordRepository } from '@repo/memory-core';
import { readRunDigest } from './run-digest.js';

/**
 * `ledger:verify` (P3-C): the seven checks, over the ledger's rows and, unless
 * `chainOnly`, the run records they commit to.
 *
 * 1-4 are the package's `verifyChain`, pure over rows. 5 is the anchors,
 * through OpenSSL against the configured CA. 6 re-derives each `run.recorded`
 * digest from the run record and checkpoints as they are now. 7 lists every
 * recorded run the ledger holds no commitment to — a visible gap, not a
 * failure, because the chat path fails open by decision.
 *
 * Exit 0 when every check holds; 1 naming the first failure, by seq and, for
 * a digest, by run; 2 when it cannot check — anchors and no CA, or a store it
 * cannot read.
 */

export type LedgerVerifyExit = 0 | 1 | 2;

export interface LedgerVerifyFailure {
  readonly check: string;
  readonly seq?: number;
  readonly runId?: string;
  readonly reason: string;
}

export interface LedgerVerifyReport {
  readonly exitCode: LedgerVerifyExit;
  readonly verdict: 'verified' | 'failed' | 'unverifiable';
  readonly chain: Omit<ChainReport, 'failure'>;
  readonly anchors: {
    readonly count: number;
    readonly lastSeq: number | null;
    readonly checked: boolean;
  };
  /** Whether checks 6 and 7 were asked for: false under `--chain-only`. */
  readonly runsRequested: boolean;
  /** Absent under `--chain-only`, or when an earlier check failed first. */
  readonly runs?: {
    readonly committed: number;
    readonly rederived: number;
    readonly uncommitted: readonly string[];
  };
  readonly failure?: LedgerVerifyFailure;
  /** Why it could not check, when `unverifiable`. */
  readonly reason?: string;
}

export interface VerifyLedgerOptions {
  readonly rows: LedgerRows;
  /** `LEDGER_TSA_CA`: needed when the ledger holds anchors. */
  readonly caFile?: string;
  /** The run records and the saver, for checks 6 and 7; omit for `--chain-only`. */
  readonly runs?: {
    readonly records: RunRecordRepository;
    readonly checkpointer: BaseCheckpointSaver;
  };
}

export async function verifyLedger(options: VerifyLedgerOptions): Promise<LedgerVerifyReport> {
  const { failure: chainFailure, verified, ...chain } = verifyChain(options.rows);
  const anchors = options.rows.anchors;
  const anchorSummary = {
    count: anchors.length,
    lastSeq: anchors.length === 0 ? null : Math.max(...anchors.map((anchor) => anchor.seq)),
    checked: false,
  };
  const base = { chain, anchors: anchorSummary, runsRequested: options.runs !== undefined };

  // 1-4.
  if (chainFailure !== undefined) {
    return { ...base, exitCode: 1, verdict: 'failed', failure: chainFailure };
  }

  // 5.
  if (anchors.length > 0) {
    if (options.caFile === undefined) {
      return {
        ...base,
        exitCode: 2,
        verdict: 'unverifiable',
        reason: `the ledger holds ${anchors.length} anchor(s) and LEDGER_TSA_CA is unset, so they cannot be checked`,
      };
    }
    const failed = await verifyAnchors(options.rows.entries, anchors, options.caFile);
    if (failed !== null) {
      return {
        ...base,
        anchors: { ...anchorSummary, checked: true },
        exitCode: 1,
        verdict: 'failed',
        failure: { check: 'anchor', seq: failed.seq, reason: failed.reason },
      };
    }
  }
  const checked = { ...base, anchors: { ...anchorSummary, checked: anchors.length > 0 } };

  if (options.runs === undefined) return { ...checked, exitCode: 0, verdict: 'verified' };

  // 6.
  const committed = new Set<string>();
  let rederived = 0;
  for (const entry of verified) {
    if (entry.payload?.kind !== 'run.recorded') continue;
    const payload = entry.payload;
    committed.add(payload.runId);
    const now = await readRunDigest(payload.runId, options.runs.records, options.runs.checkpointer);
    const mismatch =
      now === null
        ? 'its run record is gone'
        : now.runDigest !== payload.runDigest
          ? `its record, decisions or checkpoints have changed since seq ${entry.seq} committed to them ` +
            `(${now.decisionCount} decisions and ${now.checkpointCount} checkpoints now, ` +
            `${payload.decisionCount} and ${payload.checkpointCount} then)`
          : null;
    if (mismatch !== null) {
      return {
        ...checked,
        runs: { committed: committed.size, rederived, uncommitted: [] },
        exitCode: 1,
        verdict: 'failed',
        failure: {
          check: 'run-digest',
          seq: entry.seq,
          runId: payload.runId,
          reason: `run ${payload.runId}: ${mismatch}`,
        },
      };
    }
    rederived += 1;
  }

  // 7.
  const uncommitted = (await options.runs.records.runIds()).filter(
    (runId) => !committed.has(runId),
  );

  return {
    ...checked,
    runs: { committed: committed.size, rederived, uncommitted },
    exitCode: 0,
    verdict: 'verified',
  };
}

export function renderLedgerReport(report: LedgerVerifyReport): string {
  const lines: string[] = [];
  const head = report.chain.head;
  lines.push(`ledger:verify — ${report.verdict.toUpperCase()} (exit ${report.exitCode})`);
  lines.push(
    `chain: ${report.chain.entries} entries` +
      (head === null ? '' : `, head seq ${head.seq} ${head.entryHash}`),
  );
  const kinds = Object.entries(report.chain.kinds)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ');
  if (kinds !== '') lines.push(`kinds: ${kinds}`);
  if (report.chain.withheld.length > 0) {
    lines.push(`withheld payloads (not a failure): seq ${report.chain.withheld.join(', ')}`);
  }
  lines.push(
    report.anchors.count === 0
      ? 'anchors: none — nothing outside the database vouches for this chain'
      : `anchors: ${report.anchors.count}, last at seq ${report.anchors.lastSeq}` +
          (!report.anchors.checked
            ? ', not checked'
            : report.failure?.check === 'anchor'
              ? ', one fails against the CA'
              : ', verified against the CA') +
          (head !== null && report.anchors.lastSeq !== null && head.seq > report.anchors.lastSeq
            ? `; seq ${report.anchors.lastSeq + 1}-${head.seq} are after the last anchor, where a database administrator's consistent rewrite is undetectable`
            : ''),
  );
  if (report.runs !== undefined) {
    lines.push(
      `runs: ${report.runs.rederived} of ${report.runs.committed} committed digests re-derived from the current record and checkpoints`,
    );
    if (report.runs.uncommitted.length > 0) {
      lines.push(`uncommitted runs (${report.runs.uncommitted.length}):`);
      for (const runId of report.runs.uncommitted) lines.push(`  ${runId}`);
    }
  } else {
    lines.push(
      report.runsRequested
        ? 'runs: not reached, because an earlier check failed'
        : 'runs: not checked (--chain-only)',
    );
  }
  if (report.failure !== undefined) {
    const where = [
      report.failure.seq === undefined ? null : `seq ${report.failure.seq}`,
      report.failure.runId === undefined ? null : `run ${report.failure.runId}`,
    ]
      .filter((part) => part !== null)
      .join(', ');
    lines.push(`FAILED at ${where} (${report.failure.check}): ${report.failure.reason}`);
  }
  if (report.reason !== undefined) lines.push(`cannot verify: ${report.reason}`);
  return `${lines.join('\n')}\n`;
}
