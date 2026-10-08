import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { CaseRepository, OverdueCase } from '@repo/memory-core';
import type { Clock } from '@repo/prior-auth';
import { createLogger, errorType, withServiceSpan } from '@repo/telemetry';
import { CASE_REPOSITORY } from '../memory/memory.tokens.js';
import { PRIOR_AUTH_CLOCK } from '../fhir/prior-auth.service.js';

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

/**
 * The overdue sweep (P3-E): flags, never decides.
 *
 * Every period it sets `overdue_flagged_at` on each pended case whose
 * deadline has passed and that has no flag, and emits one
 * `review.case.overdue` event per case on its span. The case stays pended and
 * its response stays `queued`. Auto-denial at the deadline is what P3-A
 * forbids; auto-approval is a policy some state laws adopt and CMS's does not.
 * 42 CFR § 422.568(f) already makes the lapse an adverse determination the
 * member may appeal, which is the member's remedy and not the software's
 * decision.
 *
 * Extensions are not modelled (P3-E's non-goals), so an extended case is
 * flagged on its original deadline. That is the conservative error.
 */
@Injectable()
export class ReviewSweep implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(CASE_REPOSITORY) private readonly cases: CaseRepository,
    @Inject(PRIOR_AUTH_CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    const period = readSweepMs();
    if (period === 0) {
      logger.info({ msg: 'review.sweep.off', detail: `${REVIEW_SWEEP_MS_ENV}=0` });
      return;
    }
    this.timer = setInterval(() => {
      // One sweep at a time, and a failed one is logged, not thrown: the next
      // period tries again, and the read routes compute overdue regardless.
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

  /** One sweep at the clock's now. Returns the cases it flagged. */
  sweep(now: Date = this.clock.now()): Promise<OverdueCase[]> {
    return withServiceSpan('review.overdue_sweep', async (span) => {
      const flagged = await this.cases.flagOverdue(now);
      for (const overdue of flagged) {
        span.addEvent('review.case.overdue', {
          'prior_auth.case_id': overdue.caseId,
          'prior_auth.priority': overdue.priority,
          'prior_auth.minutes_past_due': Math.floor(
            (now.getTime() - overdue.decisionDueBy.getTime()) / 60_000,
          ),
        });
        logger.warn({
          msg: 'review.case.overdue',
          caseId: overdue.caseId,
          priority: overdue.priority,
          decisionDueBy: overdue.decisionDueBy.toISOString(),
        });
      }
      span.setAttribute('review.flagged_count', flagged.length);
      return flagged;
    });
  }
}
