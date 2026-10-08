import {
  CaseExampleSchema,
  CaseRowSchema,
  DecisionSchema,
  NewCaseSchema,
  classifyDecision,
  decidedRow,
  type CaseExample,
  type CaseRepository,
  type CaseRow,
  type DecideOptions,
  type DecideResult,
  type Decision,
  type NewCase,
  type OverdueCase,
} from './case.repo.js';

/**
 * The case store on the unconfigured memory axis: volatile, in this process,
 * gone on restart. The service warns at boot when it selects it
 * (`review.cases.volatile`), which is the axis rule — an unconfigured axis
 * runs and says so, a configured and unreachable one exits.
 *
 * It keeps `DrizzleCaseRepository`'s semantics, and one contract suite holds
 * both to them. Every row is stored and returned as a parsed copy, so a
 * caller that mutates what it read changes nothing here. `decide` holds a
 * per-case mutex across `beforeCommit`, the in-process stand-in for the row
 * lock: without it two decisions could both pass the pended check while the
 * first awaited its ledger append.
 */
export class InMemoryCaseRepository implements CaseRepository {
  private readonly rows = new Map<string, CaseRow>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async enqueue(row: NewCase): Promise<void> {
    const validated = NewCaseSchema.parse(row);
    if (this.rows.has(validated.caseId)) {
      throw new Error(`case ${validated.caseId} already exists`);
    }
    this.rows.set(
      validated.caseId,
      CaseRowSchema.parse({
        ...structuredClone(validated),
        determination: null,
        reviewerId: null,
        reviewerKeyId: null,
        signature: null,
        decidedAt: null,
        overdueFlaggedAt: null,
      }),
    );
  }

  async get(caseId: string): Promise<CaseRow | null> {
    const row = this.rows.get(caseId.toLowerCase());
    return row === undefined ? null : copy(row);
  }

  async queue(limit: number): Promise<CaseRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === 'pended')
      .sort(
        (a, b) =>
          a.decisionDueBy.getTime() - b.decisionDueBy.getTime() ||
          a.receivedAt.getTime() - b.receivedAt.getTime() ||
          byId(a.caseId, b.caseId),
      )
      .slice(0, limit)
      .map(copy);
  }

  async match(example: CaseExample): Promise<CaseRow[]> {
    const validated = CaseExampleSchema.parse(example);
    const codes =
      validated.hcpcs === undefined || validated.hcpcs.length === 0
        ? undefined
        : new Set(validated.hcpcs);
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.memberId === validated.memberId &&
          row.insurerId === validated.insurerId &&
          row.providerId === validated.providerId &&
          (codes === undefined || codes.has(row.hcpcs)),
      )
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || byId(a.caseId, b.caseId))
      .map(copy);
  }

  async decide(
    caseId: string,
    decision: Decision,
    options: DecideOptions = {},
  ): Promise<DecideResult> {
    const validated = DecisionSchema.parse(decision);
    const key = caseId.toLowerCase();
    return this.withLock(key, async () => {
      const row = this.rows.get(key);
      if (row === undefined) return { outcome: 'not-found' };

      const kind = classifyDecision(row, validated);
      if (kind !== 'decide') return { outcome: kind, row: copy(row) };

      await options.beforeCommit?.(copy(row));
      const next = decidedRow(row, structuredClone(validated));
      this.rows.set(key, next);
      return { outcome: 'decided', row: copy(next) };
    });
  }

  async flagOverdue(now: Date): Promise<OverdueCase[]> {
    const flagged: OverdueCase[] = [];
    for (const row of this.rows.values()) {
      if (
        row.status === 'pended' &&
        row.overdueFlaggedAt === null &&
        row.decisionDueBy.getTime() <= now.getTime()
      ) {
        this.rows.set(row.caseId, { ...row, overdueFlaggedAt: new Date(now) });
        flagged.push({
          caseId: row.caseId,
          priority: row.priority,
          decisionDueBy: new Date(row.decisionDueBy),
        });
      }
    }
    return flagged.sort(
      (a, b) => a.decisionDueBy.getTime() - b.decisionDueBy.getTime() || byId(a.caseId, b.caseId),
    );
  }

  /**
   * Runs `fn` holding this case's mutex, with the row as it is now and a way
   * to replace it. It is how `InMemoryAppealRepository` shares this store's
   * lock (P3-F): an appeal and its case are written under one mutex, as a
   * Postgres transaction holds both rows. `fn` reads and writes copies.
   */
  async transact<T>(
    caseId: string,
    fn: (row: CaseRow | undefined, write: (next: CaseRow) => void) => Promise<T>,
  ): Promise<T> {
    const key = caseId.toLowerCase();
    return this.withLock(key, async () => {
      const row = this.rows.get(key);
      return fn(row === undefined ? undefined : copy(row), (next) => {
        const parsed = CaseRowSchema.parse(structuredClone(next));
        if (parsed.caseId !== key)
          throw new Error(`a write under ${key}'s lock names another case`);
        this.rows.set(key, parsed);
      });
    });
  }

  /** Runs `fn` after every earlier holder of this case's lock has finished. */
  private async withLock<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(caseId) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const settled = current.catch(() => undefined);
    this.locks.set(caseId, settled);
    try {
      return await current;
    } finally {
      if (this.locks.get(caseId) === settled) this.locks.delete(caseId);
    }
  }
}

function copy(row: CaseRow): CaseRow {
  return CaseRowSchema.parse(structuredClone(row));
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
