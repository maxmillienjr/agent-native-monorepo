import {
  buildDecision,
  encodeError,
  encodeResponse,
  type Deck,
  type DecisionCall,
  type RecordedDecision,
} from '@repo/agent-cassette';
import type { RecordSeam, RunRecordRepository } from '@repo/memory-core';
import { createLogger } from '@repo/telemetry';
import { tokenCountsFor } from '../agent/model/decision-seam.js';

const logger = createLogger('run-record');

/**
 * What a run does when its record cannot be written (P3-B, decided at review).
 *
 * `fail-closed` is the regulated path's: a run that produces a recommendation
 * or a determination — the prior-authorization graph — does not return a
 * decision it could not record. `fail-open` is the chat path's: the run
 * completes, the failure is logged, and the record is closed `partial` so the
 * gap can be found by a query.
 */
export type RecordFailurePolicy = 'fail-open' | 'fail-closed';

/**
 * A run record that could not be written, on the fail-closed path.
 *
 * Its own name so that `IO_RETRY` does not retry it: a retried `assess` would
 * make a second model call whose answer could not be recorded either. The
 * FHIR surface answers it with a 503 rather than a `ClaimResponse`.
 */
export class RunRecordWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunRecordWriteError';
  }
}

export interface PersistingDeckOptions {
  readonly repository: RunRecordRepository;
  readonly runId: string;
  /** The next ordinal: 0 for a new record, the count already held for a re-opened one. */
  readonly firstOrdinal: number;
  readonly policy: RecordFailurePolicy;
}

/**
 * The cassette's `Deck`, writing to a run record instead of a file.
 *
 * Each decision is appended as it resolves and awaited before the graph sees
 * the answer, rather than buffered until the run ends as a cassette is: the
 * run an auditor most wants is the one that crashed, and a buffer dies with
 * the process. A failed call is recorded and then rethrown, so a retried node
 * leaves the error and then the success, which is what replay serves back.
 *
 * The decision is built by `buildDecision`, the recorder's own, so a record and
 * a cassette of the same call hash and redact it identically.
 */
export class PersistingDeck implements Deck<RecordSeam> {
  readonly mode = 'record';

  private nextOrdinal: number;
  private failedAppends = 0;

  constructor(private readonly options: PersistingDeckOptions) {
    this.nextOrdinal = options.firstOrdinal;
  }

  /** How many appends failed on the fail-open path. Non-zero closes the record `partial`. */
  get gaps(): number {
    return this.failedAppends;
  }

  async resolve<R>(call: DecisionCall<RecordSeam>, live: () => Promise<R>): Promise<R> {
    const startedAt = Date.now();
    let result: R;

    try {
      result = await live();
    } catch (error) {
      await this.append(buildDecision(call, encodeError(error), Date.now() - startedAt));
      throw error;
    }

    await this.append(
      buildDecision(
        call,
        encodeResponse(call.seam, result),
        Date.now() - startedAt,
        tokenCountsFor(call, result),
      ),
    );
    return result;
  }

  private async append(decision: RecordedDecision<RecordSeam>): Promise<void> {
    // Taken before the write, so the ordinals are the order decisions resolved
    // in even if a write were slow; the graph calls one seam at a time.
    const ordinal = this.nextOrdinal;
    this.nextOrdinal += 1;

    try {
      await this.options.repository.append(this.options.runId, ordinal, decision);
    } catch (error) {
      this.failedAppends += 1;
      const message = error instanceof Error ? error.message : String(error);

      if (this.options.policy === 'fail-closed') {
        throw new RunRecordWriteError(
          `run ${this.options.runId}: decision ${ordinal} at \`${decision.seam}\` could not be ` +
            'recorded, and this path does not return a decision it could not record',
          { cause: error },
        );
      }

      logger.error({
        msg: 'run.record.append_failed',
        runId: this.options.runId,
        ordinal,
        seam: decision.seam,
        error: message,
      });
    }
  }
}
