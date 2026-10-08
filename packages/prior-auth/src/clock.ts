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
