import type { Reconsideration } from '@repo/determination';
import {
  AppealRowSchema,
  NewAppealSchema,
  appealableReviewer,
  checkDismissal,
  checkInvolvement,
  checkReconsideration,
  classifyAction,
  dismissedRow,
  filedRow,
  forwardedOf,
  lapsedRow,
  notAppealable,
  reconsideredRow,
  type ActionOptions,
  type ActionResult,
  type AppealRepository,
  type AppealRow,
  type Dismissal,
  type FileOptions,
  type FileResult,
  type ForwardedAppeal,
  type NewAppeal,
  type ReconsiderOptions,
  type SignedAction,
} from './appeal.repo.js';
import type { CaseRow } from './case.repo.js';
import type { InMemoryCaseRepository } from './in-memory.repo.js';

/**
 * The appeal store on the unconfigured memory axis: volatile, in this
 * process, gone on restart, like the case store it is built over.
 *
 * It keeps `DrizzleAppealRepository`'s semantics, and one contract suite holds
 * both to them. It is constructed over the `InMemoryCaseRepository` whose
 * cases it references, and every write holds that store's per-case mutex, the
 * in-process stand-in for locking the appeal row and the case row in one
 * transaction. The checks Postgres makes by constraint, the initial reviewer
 * being the case's and the acting reviewer being someone else, are made here
 * in code, from the same functions the Drizzle store calls.
 */
export class InMemoryAppealRepository implements AppealRepository {
  private readonly rows = new Map<string, AppealRow>();

  constructor(private readonly cases: InMemoryCaseRepository) {}

  async file(row: NewAppeal, options: FileOptions = {}): Promise<FileResult> {
    const validated = NewAppealSchema.parse(row);
    return this.cases.transact(validated.caseId, async (caseRow): Promise<FileResult> => {
      if (caseRow === undefined) return { outcome: 'not-found' };
      const initialReviewerId = appealableReviewer(caseRow);
      if (initialReviewerId === null) return notAppealable(caseRow);

      const open = [...this.rows.values()].find(
        (appeal) => appeal.caseId === validated.caseId && appeal.status !== 'dismissed',
      );
      if (open !== undefined) return { outcome: 'already-open', row: copy(open) };
      if (this.rows.has(validated.appealId)) {
        throw new Error(`appeal ${validated.appealId} already exists`);
      }

      const filed = filedRow(structuredClone(validated), initialReviewerId);
      await options.beforeCommit?.(structuredClone(validated), caseRow);
      this.rows.set(filed.appealId, filed);
      return { outcome: 'filed', row: copy(filed) };
    });
  }

  async get(appealId: string): Promise<AppealRow | null> {
    const row = this.rows.get(appealId.toLowerCase());
    return row === undefined ? null : copy(row);
  }

  async queue(limit: number): Promise<AppealRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === 'filed')
      .sort(
        (a, b) =>
          a.reconsiderationDueBy.getTime() - b.reconsiderationDueBy.getTime() ||
          a.receivedAt.getTime() - b.receivedAt.getTime() ||
          byId(a.appealId, b.appealId),
      )
      .slice(0, limit)
      .map(copy);
  }

  async reconsider(
    appealId: string,
    reconsideration: Reconsideration,
    signed: SignedAction,
    options: ReconsiderOptions = {},
  ): Promise<ActionResult> {
    const checked = checkReconsideration(reconsideration, signed, options);
    return this.act(appealId, checked.signed, async (appeal, caseRow, writeCase) => {
      checkInvolvement(appeal, checked.signed.reviewerId, checked.record.initialReviewerId);
      await options.beforeCommit?.(copy(appeal), caseRow);
      const next = reconsideredRow(appeal, caseRow, checked.record, checked.signed);
      if (checked.record.kind === 'reversal' && options.response !== undefined) {
        const reversed = { ...caseRow, response: structuredClone(options.response) };
        writeCase(reversed);
        return { row: next, caseRow: reversed };
      }
      return { row: next, caseRow };
    });
  }

  async dismiss(
    appealId: string,
    dismissal: Dismissal,
    signed: SignedAction,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    const checked = checkDismissal(dismissal, signed);
    return this.act(appealId, checked.signed, async (appeal, caseRow) => {
      checkInvolvement(appeal, checked.signed.reviewerId);
      await options.beforeCommit?.(copy(appeal), caseRow);
      return { row: dismissedRow(appeal, checked.dismissal, checked.signed), caseRow };
    });
  }

  async forwardLapsed(now: Date): Promise<ForwardedAppeal[]> {
    const candidates = [...this.rows.values()]
      .filter(
        (row) => row.status === 'filed' && row.reconsiderationDueBy.getTime() <= now.getTime(),
      )
      .sort(
        (a, b) =>
          a.reconsiderationDueBy.getTime() - b.reconsiderationDueBy.getTime() ||
          byId(a.appealId, b.appealId),
      );
    const forwarded: ForwardedAppeal[] = [];
    for (const candidate of candidates) {
      await this.cases.transact(candidate.caseId, async (caseRow) => {
        const appeal = this.rows.get(candidate.appealId);
        // Re-read under the lock: a write may have moved it since the scan.
        if (appeal === undefined || appeal.status !== 'filed') return;
        if (caseRow === undefined) throw new Error(`appeal ${appeal.appealId} has no case`);
        const next = lapsedRow(appeal, caseRow, now);
        this.rows.set(next.appealId, next);
        forwarded.push(forwardedOf(next));
      });
    }
    return forwarded;
  }

  private async act(
    appealId: string,
    signed: SignedAction,
    apply: (
      appeal: AppealRow,
      caseRow: CaseRow,
      writeCase: (next: CaseRow) => void,
    ) => Promise<{ row: AppealRow; caseRow: CaseRow }>,
  ): Promise<ActionResult> {
    const known = this.rows.get(appealId.toLowerCase());
    if (known === undefined) return { outcome: 'not-found' };
    // An appeal's case never changes, so its id is safe to read before the lock.
    return this.cases.transact(known.caseId, async (caseRow, writeCase): Promise<ActionResult> => {
      const appeal = this.rows.get(known.appealId);
      if (appeal === undefined || caseRow === undefined) {
        throw new Error(`appeal ${known.appealId} has no case`);
      }
      const kind = classifyAction(appeal, signed.signature, signed.decidedAt);
      if (kind === 'unchanged' || kind === 'conflict') {
        return { outcome: kind, row: copy(appeal), caseRow };
      }
      if (kind === 'lapse') {
        const next = lapsedRow(appeal, caseRow, signed.decidedAt);
        this.rows.set(next.appealId, next);
        return { outcome: 'lapsed', row: copy(next), caseRow };
      }
      // Writes to the case are staged, so a throw after one leaves both stores as they were.
      let stagedCase: CaseRow | undefined;
      const result = await apply(copy(appeal), caseRow, (next) => {
        stagedCase = next;
      });
      if (stagedCase !== undefined) writeCase(stagedCase);
      this.rows.set(result.row.appealId, AppealRowSchema.parse(structuredClone(result.row)));
      return { outcome: 'recorded', row: copy(result.row), caseRow: result.caseRow };
    });
  }
}

function copy(row: AppealRow): AppealRow {
  return AppealRowSchema.parse(structuredClone(row));
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
