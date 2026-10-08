/**
 * The reconsideration clocks (P3-F), under Medicare Advantage's Part 422,
 * Subpart M, and nothing else.
 *
 * Two clocks, which err in opposite directions on purpose. The
 * reconsideration deadline is the plan's obligation, so it is the earliest
 * instant any reading of the rule allows, as `decisionDueBy` is. The filing
 * deadline is the enrollee's, so it is the latest, and a filing after it is
 * still recorded: § 422.582(c) lets a party ask for good cause in the same
 * request, and a person decides.
 */
import type { Priority } from './clock.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Thirty calendar days, counted as 720 hours (§ 422.590(a)(1)-(2)). */
export const STANDARD_RECONSIDERATION_HOURS = 30 * 24;
/** Seventy-two hours after receiving the request (§ 422.590(e)(1)). */
export const EXPEDITED_RECONSIDERATION_HOURS = 72;

/** Sixty calendar days after receipt of the notice (§ 422.582(b)). */
export const FILING_DAYS = 60;
/** Receipt of the notice is presumed five days after its date (§ 422.582(b)(1)). */
export const PRESUMED_NOTICE_DELAY_DAYS = 5;

/**
 * When the reconsidered determination is due.
 *
 * Its parameters are the plan's receipt of the request and its priority, and
 * nothing a finding, a filer or a reviewer produces. That is P3-D's first
 * SB 1120 invariant applied to the second clock, and `appeal-clock.test-d.ts`
 * holds the parameter list to exactly those two.
 *
 * A late filing gets the full clock from its receipt: the deadline is the
 * plan's, and how late the enrollee was does not shorten it.
 */
export function reconsiderationDueBy(receivedAt: Date, priority: Priority): Date {
  const hours =
    priority === 'expedited' ? EXPEDITED_RECONSIDERATION_HOURS : STANDARD_RECONSIDERATION_HOURS;
  return new Date(receivedAt.getTime() + hours * HOUR_MS);
}

/**
 * Whether a reconsideration is past its deadline: from the instant it is due.
 * A filed appeal at that instant has lapsed, which § 422.590(d) makes an
 * affirmation the plan must forward.
 */
export function isLapsed(a: { readonly reconsiderationDueBy: Date }, now: Date): boolean {
  return now.getTime() >= a.reconsiderationDueBy.getTime();
}

/**
 * The last instant a request for reconsideration is timely.
 *
 * The rule counts 60 days from receipt of the written notice and presumes
 * receipt 5 days after the notice's date "unless there is evidence to the
 * contrary" (§ 422.582(b)(1)). No notice is sent here, so the determination's
 * `decided_at` stands in for its date: it is when the denial became available
 * to `$inquire`, the earliest a notice could carry. The deadline is the end of
 * the UTC calendar day 65 days after that, or 60 days after
 * `noticeReceivedAt` when the filer gives a later receipt. An earlier
 * `noticeReceivedAt` does not shorten it: the presumption is the filer's.
 */
export function filingDeadline(input: {
  readonly determinationDate: Date;
  readonly noticeReceivedAt?: Date;
}): Date {
  const presumed = endOfUtcDay(
    input.determinationDate.getTime() + (PRESUMED_NOTICE_DELAY_DAYS + FILING_DAYS) * DAY_MS,
  );
  if (input.noticeReceivedAt === undefined) return presumed;
  const evidenced = endOfUtcDay(input.noticeReceivedAt.getTime() + FILING_DAYS * DAY_MS);
  return evidenced.getTime() > presumed.getTime() ? evidenced : presumed;
}

/** The last millisecond of the UTC calendar day containing `ms`. */
function endOfUtcDay(ms: number): Date {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS - 1);
}
