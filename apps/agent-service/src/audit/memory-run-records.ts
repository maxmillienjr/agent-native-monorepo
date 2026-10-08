import {
  RunDecisionSchema,
  RunRecordOpenSchema,
  type RunDecision,
  type RunOutcome,
  type RunRecordOpen,
  type RunRecordRepository,
  type StoredRun,
} from '@repo/memory-core';

/**
 * A `RunRecordRepository` held in memory, for unit tests of the recording
 * wiring. It parses what it is given as the Postgres one does, and can be told
 * to fail an operation, which is what the fail-open and fail-closed tests need.
 * Nothing in the service constructs it.
 */
export class InMemoryRunRecords implements RunRecordRepository {
  readonly runs = new Map<string, StoredRun>();
  failOn: 'open' | 'append' | 'close' | undefined;

  async open(input: RunRecordOpen): Promise<{ created: boolean; decisions: number }> {
    if (this.failOn === 'open') throw new Error('open refused by the test');
    const record = RunRecordOpenSchema.parse(input);
    const existing = this.runs.get(record.runId);
    if (existing !== undefined) return { created: false, decisions: existing.decisions.length };

    this.runs.set(record.runId, {
      record: {
        ...record,
        startedAt: record.startedAt ?? new Date(),
        finishedAt: null,
        outcome: null,
      },
      decisions: [],
    });
    return { created: true, decisions: 0 };
  }

  async append(runId: string, ordinal: number, decision: RunDecision): Promise<void> {
    if (this.failOn === 'append') throw new Error('append refused by the test');
    const stored = this.runs.get(runId);
    if (stored === undefined) throw new Error(`no run ${runId}`);
    if (stored.decisions.some((row) => row.ordinal === ordinal)) {
      throw new Error(`ordinal ${ordinal} is taken`);
    }
    this.runs.set(runId, {
      ...stored,
      decisions: [
        ...stored.decisions,
        { ordinal, formatVersion: 2, decision: RunDecisionSchema.parse(decision) },
      ],
    });
  }

  async close(runId: string, outcome: RunOutcome): Promise<void> {
    if (this.failOn === 'close') throw new Error('close refused by the test');
    const stored = this.runs.get(runId);
    if (stored === undefined) throw new Error(`no run ${runId}`);
    this.runs.set(runId, {
      ...stored,
      record: { ...stored.record, finishedAt: new Date(), outcome },
    });
  }

  async read(runId: string): Promise<StoredRun | null> {
    return this.runs.get(runId) ?? null;
  }

  /** The only run held, for a test that made one. */
  only(): StoredRun {
    const [run, ...others] = [...this.runs.values()];
    if (run === undefined || others.length > 0) {
      throw new Error(`expected exactly one run, found ${this.runs.size}`);
    }
    return run;
  }
}
