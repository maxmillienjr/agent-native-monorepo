# 0015 · A timer whose action is one local transaction stays in the case layer

**Status:** accepted
**Date:** 2026-10-08

## Context

[ADR 0010](0010-the-prior-auth-case-lives-above-the-graph.md) put the prior-authorization
case in a table above the graph and named the condition under which that table should give
way to a durable-execution engine:

> **Revisit when** the case needs a timer that acts, or a wait that must survive a crash
> mid-step. Two are in view: forwarding an affirmed denial to the independent review entity
> (§ 422.590, P3-F's territory), and a request for information that stops the clock
> (§ 422.568(b)(2)), which P3-E leaves unmodelled.

P3-F builds the first of those. Reading § 422.590 against that sentence separates two
forwards the ADR treats as one:

- **An affirmed denial.** "If the MA organization affirms, in whole or in part, its adverse
  organization determination, the issues that remain in dispute must be reviewed and
  resolved by an independent, outside entity" (§ 422.592(a)). The plan forwards the case
  file when a physician affirms, so the forward happens inside the request that affirms it.
  No timer is involved.
- **A reconsideration not decided in time.** "If the MA organization fails to provide the
  enrollee with a reconsidered determination within the timeframes specified … this failure
  constitutes an affirmation of its adverse organization determination, and the MA
  organization must submit the file to the independent entity" (§ 422.590(d)), within
  24 hours of the deadline for an expedited one (§ 422.590(g)). Nothing but a timer can do
  that, because no person acts.

The second is a timer that acts, so ADR 0010's trigger fires. The question this record
answers is whether it fires for the reason the trigger was written for.

## Decision

**A timer whose action is one transaction in the database the timer reads stays in the case
layer.** The revisit trigger of ADR 0010 is narrowed to **a timer or a wait whose action
crosses a process boundary**.

P3-F's lapse qualifies on every count:

- **The action is one conditional `UPDATE`.** `AppealRepository.forwardLapsed` moves each
  `filed` appeal at or past its deadline to `forwarded` with
  `forward_reason = 'deadline-lapsed'`, a case-file digest and `forwarded_at`. Each appeal
  is its own short transaction: lock the row, check it is still `filed`, and update it
  `WHERE status = 'filed'`.
- **A crash leaves no intermediate state.** The row is `filed` or `forwarded`, never between.
  A second sweep, or a sweep running beside another instance's, finds nothing to do for a
  row already moved, and the e2e spec runs two sweeps over one lapsed appeal to show one
  forward and one event.
- **There is nothing to retry or compensate.** The forward is a record, not a delivery: no
  independent-entity system is contacted, so no call can fail after the plan has committed
  to it.
- **The timer is not the only path.** A reconsideration or dismissal that finds the appeal
  lapsed forwards it in its own transaction before answering `409`, and every read computes
  `lapsed` from the clock. A sweep that never runs delays the record of a forward, not the
  forward's effect on what the service will accept.

**With P3-C's ledger configured, the forward also appends an entry**, to a second database,
before the row commits. That is the pattern P3-C already uses for a determination, and it
does not cross the line this record draws. The ledger is the plan's own store, not an
outside party's, and the append converges under retry rather than needing compensation.
The entry's id is derived from the appeal, and its payload, the reason and the case-file
digest, holds no instant the forward sets. So a crash after the append and before the
commit leaves an entry and a filed appeal, and the next attempt appends the same bytes,
gets the stored entry back and commits. A failed append rolls the forward back, the appeal
stays filed, and the sweep goes on to the next one.

The sweep stays P3-E's `ReviewSweep`, which gains one call per period after `flagOverdue`.
It still never decides a pended case: the forward is the consequence § 422.590(d) and (g)
fix, not a determination, and it carries no medical-necessity reading.

This record narrows ADR 0010 and does not supersede it, the way ADR 0008 narrows ADR 0003.
ADR 0010's decision, that the case lives in a table and the graph stays linear, is
unchanged.

## Consequences

**What would cross the boundary.** The forward becoming a delivery: a submission to an
outside independent-review system that can fail, time out or be partly received after the
plan has committed. That needs retries with backoff, idempotency keys the other side
honours, and compensation when it fails after the local commit, and a durable-execution
engine earns its operational cost there. The same holds for a request for information that
stops the clock and waits for an outside party's callback. When either is built, it is the
revisit, and this table is what the engine would replace.

**What this costs.** The forward depends on the sweep's period for its timing. The default
is 60 seconds and § 422.590(g) allows 24 hours, so the margin is wide, but a deployment that
turns the sweep off (`REVIEW_SWEEP_MS=0`) records lapse forwards only when a write touches
the appeal. The STATUS row says so.

**What a reviewer might reject.** The lapse forward is the one action in this layer no
clinician signs. It moves a case towards independent review and away from the plan, which is
the direction the regulation requires, and it is outside what P3-A forbids (an adverse
determination without a clinician) and what P3-D's SB 1120 reading rules out (the tool
delaying a decision). A reviewer who reads "the tool shall not … delay" to cover any
automated step on a case would disagree. This record states the argument so it can be
rejected on its terms.
