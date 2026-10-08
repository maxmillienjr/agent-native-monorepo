import type { Deck } from '@repo/agent-cassette';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type RecordSeam,
  type RecordedModelAxis,
  type RunGraph,
  type RunOutcome,
  type RunRecordRepository,
} from '@repo/memory-core';
import { createLogger } from '@repo/telemetry';
import { CHAT_MODEL } from '../agent/model/model-deps.js';
import { codeIdentity, type CodeIdentity } from './code-identity.js';
import {
  PersistingDeck,
  RunRecordWriteError,
  type RecordFailurePolicy,
} from './persisting-deck.js';

const logger = createLogger('run-record');

/** What the caller knows about a run before it starts. */
export interface RunHeader {
  readonly runId: string;
  readonly graph: RunGraph;
  readonly sessionId: string | null;
  readonly correlationId: string;
  /** The body as received, before any parse. */
  readonly request: unknown;
  readonly modelAxis: RecordedModelAxis;
  /** When the request was received, when the graph reads it as an input. */
  readonly startedAt?: Date;
}

/**
 * Opens a run's record, hands the run a deck that appends to it, and closes
 * it with the outcome (P3-B).
 *
 * On the unconfigured memory axis there is no repository and nothing is
 * recorded: the run gets no deck, exactly as before. That axis is the
 * no-database path a clone with no `.env` runs on, and it holds no audit
 * trail of any kind — the checkpointer is off there too.
 *
 * Opening fails the run on both paths, before any work is done: a run whose
 * record cannot even be started has nothing to be audited against. What
 * happens to a later failure is the caller's `RecordFailurePolicy`.
 */
export class RunRecorder {
  constructor(
    private readonly repository: RunRecordRepository | null,
    private readonly identity: () => CodeIdentity = codeIdentity,
  ) {}

  async record<T>(
    header: RunHeader,
    policy: RecordFailurePolicy,
    work: (deck: Deck<RecordSeam> | undefined) => Promise<T>,
  ): Promise<T> {
    const repository = this.repository;
    if (repository === null) return work(undefined);

    const code = this.identity();
    let opened: { decisions: number };
    try {
      opened = await repository.open({
        runId: header.runId,
        graph: header.graph,
        sessionId: header.sessionId,
        correlationId: header.correlationId,
        request: header.request,
        gitSha: code.sha,
        gitDirty: code.dirty,
        chatModel: CHAT_MODEL,
        embeddingModel: EMBEDDING_MODEL,
        embeddingDimensions: EMBEDDING_DIMENSIONS,
        modelAxis: header.modelAxis,
        ...(header.startedAt === undefined ? {} : { startedAt: header.startedAt }),
      });
    } catch (error) {
      if (policy === 'fail-closed') {
        throw new RunRecordWriteError(`run ${header.runId}: the record could not be opened`, {
          cause: error,
        });
      }
      throw error;
    }

    const deck = new PersistingDeck({
      repository,
      runId: header.runId,
      firstOrdinal: opened.decisions,
      policy,
    });

    let outcome: RunOutcome = 'error';
    try {
      const result = await work(deck);
      outcome = deck.gaps > 0 ? 'partial' : 'success';
      return result;
    } finally {
      await this.close(repository, header.runId, outcome, policy);
    }
  }

  /**
   * Fail-closed on a run that succeeded is the one case a close failure must
   * surface: the decision is about to be returned, and its record says the run
   * never finished. Anywhere else it is logged. A run that already failed
   * keeps its own error rather than this one.
   */
  private async close(
    repository: RunRecordRepository,
    runId: string,
    outcome: RunOutcome,
    policy: RecordFailurePolicy,
  ): Promise<void> {
    try {
      await repository.close(runId, outcome);
    } catch (error) {
      if (policy === 'fail-closed' && outcome !== 'error') {
        throw new RunRecordWriteError(`run ${runId}: the record could not be closed`, {
          cause: error,
        });
      }
      logger.error({
        msg: 'run.record.close_failed',
        runId,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
