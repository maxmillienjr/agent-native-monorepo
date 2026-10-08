/**
 * The request clock, under CMS-0057-F's timeframes and nothing else.
 *
 * Medicare Advantage must decide an expedited request within 72 hours and a
 * standard one within 7 calendar days of receiving it (42 CFR 422.572(a),
 * 422.568(b)(1)(ii)). The fictional plans are modelled as impacted payers
 * under those timeframes. A state clock with different arithmetic would be a
 * second function beside this one, not a parameter of it.
 */
export type Priority = 'expedited' | 'standard';

const HOUR_MS = 60 * 60 * 1000;

/** Seven calendar days, counted as 168 hours: the earliest instant any reading of the rule allows. */
export const STANDARD_DECISION_HOURS = 7 * 24;
export const EXPEDITED_DECISION_HOURS = 72;

/**
 * When the decision is due.
 *
 * Its parameters are the payer's receipt and the request's priority, and
 * nothing the agent produces. That is the first invariant P3-D's reading of
 * SB 1120 rests on: referral cannot restart, pause or extend the deadline,
 * because nothing a referral carries can reach this function.
 * `clock.test-d.ts` holds the parameter list to exactly that.
 */
export function decisionDueBy(receivedAt: Date, priority: Priority): Date {
  const hours = priority === 'expedited' ? EXPEDITED_DECISION_HOURS : STANDARD_DECISION_HOURS;
  return new Date(receivedAt.getTime() + hours * HOUR_MS);
}

/**
 * Whether a case is past its deadline: from the instant it is due, not after.
 *
 * Like `decisionDueBy`, it reads the clock and nothing else. A request
 * received at 10:00 on 1 March is due at 10:00 on 8 March, and at that instant
 * the plan has failed to decide within seven days, which § 422.568(f) makes an
 * adverse determination the member may appeal.
 */
export function isOverdue(c: { readonly decisionDueBy: Date }, now: Date): boolean {
  return now.getTime() >= c.decisionDueBy.getTime();
}

/**
 * Everything the review queue may sort on.
 *
 * It has no field a finding, a disposition or a referral reason could reach.
 * That is the P3-E half of P3-D's SB 1120 reading: if the queue put a case
 * lower because the agent found a criterion not met, the tool's reading of
 * medical necessity would have postponed a clinician's attention to it, which
 * is the "delay" the reading says the tool never causes. `clock.test-d.ts`
 * fails `yarn turbo typecheck` if a key is added or removed.
 */
export interface QueueKey {
  readonly caseId: string;
  readonly receivedAt: Date;
  readonly decisionDueBy: Date;
}

/**
 * The queue's order: earliest deadline first, then earliest receipt, then the
 * case id, so that two cases with identical clocks still have one order. The
 * partial index on `prior_auth_cases` orders by the same three columns.
 */
export function compareCases(a: QueueKey, b: QueueKey): number {
  return (
    a.decisionDueBy.getTime() - b.decisionDueBy.getTime() ||
    a.receivedAt.getTime() - b.receivedAt.getTime() ||
    (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0)
  );
}

/**
 * The priority a `Claim.priority` code means.
 *
 * PAS makes `Claim.priority` 1..1 with an example binding to base R4's
 * `process-priority`. `stat` is expedited and anything else is standard, so an
 * unknown code errs towards the longer clock only when the requester did not
 * ask for speed in the one vocabulary this surface reads. PAS's
 * `levelOfServiceType` extension is X12-bound and is not read (ADR 0008).
 */
export function priorityFromCode(code: string | undefined): Priority {
  return code === 'stat' ? 'expedited' : 'standard';
}

/**
 * The server's clock, injected so a test can fix it.
 *
 * `receivedAt` is taken from here at the controller and never from
 * `Claim.created`, which the submitter asserts: the rule counts from the
 * payer receiving the request, and that is the only receipt it can attest to.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
