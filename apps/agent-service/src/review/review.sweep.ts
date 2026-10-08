import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type {
  AppealRepository,
  CaseRepository,
  ForwardedAppeal,
  OverdueCase,
} from '@repo/memory-core';
import type { Clock } from '@repo/prior-auth';
import { createLogger, errorType, withServiceSpan } from '@repo/telemetry';
import { APPEAL_REPOSITORY, CASE_REPOSITORY } from '../memory/memory.tokens.js';
import { PRIOR_AUTH_CLOCK } from '../fhir/prior-auth.service.js';
import { RUN_LEDGER } from '../ledger/ledger.tokens.js';
import type { RunLedger } from '../ledger/run-ledger.js';

const logger = createLogger('review-sweep');

/** The variable that sets the sweep's period; `0` turns the timer off. */
export const REVIEW_SWEEP_MS_ENV = 'REVIEW_SWEEP_MS';
const DEFAULT_SWEEP_MS = 60_000;

/** Reads `REVIEW_SWEEP_MS`: a whole number of milliseconds, default 60000, 0 for no timer. */
export function readSweepMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[REVIEW_SWEEP_MS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SWEEP_MS;
  const parsed = z.coerce.number().int().nonnegative().safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${REVIEW_SWEEP_MS_ENV} is ${raw}; it must be a whole number of milliseconds`);
  }
  return parsed.data;
}

/** What one sweep did. */
export interface SweepResult {
  /** Pended cases flagged overdue, and left pended. */
  readonly flagged: OverdueCase[];
  /** Filed appeals forwarded as deemed affirmed. */
  readonly forwarded: ForwardedAppeal[];
}

/**
 * The overdue sweep (P3-E), which flags and never decides, and the lapse
 * forward (P3-F), which is the one timer in the case layer that acts.
 *
 * Every period it first sets `overdue_flagged_at` on each pended case whose
 * deadline has passed and that has no flag, and emits one
 * `review.case.overdue` event per case on its span. The case stays pended and
 * its response stays `queued`. Auto-denial at the deadline is what P3-A
 * forbids; auto-approval is a policy some state laws adopt and CMS's does not.
 * 42 CFR § 422.568(f) already makes the lapse an adverse determination the
 * member may appeal, which is the member's remedy and not the software's
 * decision.
 *
 * Then it forwards each filed appeal at or past its reconsideration deadline
 * to the independent entity as deemed affirmed, and emits one
 * `review.appeal.forwarded` event per appeal. That is not a decision: § 422.590(d)
 * makes the missed deadline the affirmation and requires the forward, and
 * § 422.590(g) allows 24 hours for an expedited one against this sweep's
 * default minute. ADR 0015 records why a timer whose action is one local
 * update stays here rather than in a workflow engine. A forward is a record,
 * not a delivery: no independent-entity system is contacted.
 *
 * Extensions are not modelled (P3-E's and P3-F's non-goals), so an extended
 * case is flagged, and an extended appeal forwarded, on its original deadline.
 * That is the conservative error both times.
 */
@Injectable()
export class ReviewSweep implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(CASE_REPOSITORY) private readonly cases: CaseRepository,
    @Inject(APPEAL_REPOSITORY) private readonly appeals: AppealRepository,
    @Inject(PRIOR_AUTH_CLOCK) private readonly clock: Clock,
    @Inject(RUN_LEDGER) private readonly runLedger: RunLedger | null = null,
  ) {}

  onModuleInit(): void {
    const period = readSweepMs();
    if (period === 0) {
      logger.info({ msg: 'review.sweep.off', detail: `${REVIEW_SWEEP_MS_ENV}=0` });
      return;
    }
    this.timer = setInterval(() => {
      // One sweep at a time, and a failed one is logged, not thrown: the next
      // period tries again, and the read routes compute overdue and lapsed
      // regardless.
      this.running = this.running.then(() =>
        this.sweep().catch((error: unknown) =>
          logger.error({ msg: 'review.sweep.failed', errorType: errorType(error) }),
        ),
      );
    }, period);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.running;
  }

  /** One sweep at the clock's now. */
  sweep(now: Date = this.clock.now()): Promise<SweepResult> {
    return withServiceSpan('review.overdue_sweep', async (span) => {
      const flagged = await this.cases.flagOverdue(now);
      for (const overdue of flagged) {
        span.addEvent('review.case.overdue', {
          'prior_auth.case_id': overdue.caseId,
          'prior_auth.priority': overdue.priority,
          'prior_auth.minutes_past_due': minutesPast(now, overdue.decisionDueBy),
        });
        logger.warn({
          msg: 'review.case.overdue',
          caseId: overdue.caseId,
          priority: overdue.priority,
          decisionDueBy: overdue.decisionDueBy.toISOString(),
        });
      }
      span.setAttribute('review.flagged_count', flagged.length);

      // With a ledger (P3-C), each forward is appended before it is recorded;
      // a failed append stops the sweep there, and the appeal waits, filed,
      // for the next one.
      const runLedger = this.runLedger;
      const forwarded = await this.appeals.forwardLapsed(
        now,
        runLedger === null ? {} : { beforeCommit: (next) => runLedger.appendAppeal(next) },
      );
      for (const appeal of forwarded) {
        span.addEvent('review.appeal.forwarded', {
          'prior_auth.appeal_id': appeal.appealId,
          'prior_auth.case_id': appeal.caseId,
          'prior_auth.priority': appeal.priority,
          'prior_auth.forward_reason': 'deadline-lapsed',
          'prior_auth.minutes_past_due': minutesPast(now, appeal.reconsiderationDueBy),
        });
        logger.warn({
          msg: 'review.appeal.forwarded',
          appealId: appeal.appealId,
          caseId: appeal.caseId,
          priority: appeal.priority,
          reconsiderationDueBy: appeal.reconsiderationDueBy.toISOString(),
        });
      }
      span.setAttribute('review.forwarded_count', forwarded.length);
      return { flagged, forwarded };
    });
  }
}

function minutesPast(now: Date, due: Date): number {
  return Math.floor((now.getTime() - due.getTime()) / 60_000);
}
