# 0010 · The prior-authorization case lives above the graph

**Status:** accepted
**Date:** 2026-10-08

## Context

[ADR 0001](0001-langgraph-over-a-durable-execution-engine.md) chose LangGraph's checkpointer
over a workflow engine because "agent runs here are measured in seconds". It also named the
thing on the other side of that choice: "A prior authorization is submitted, pends for
records, waits on a clinician, and may be appealed — days to weeks, mostly spent idle, with
external callbacks and durable timers." It closes with two sentences this record answers:

> **Revisit if** a single run starts spanning minutes with external callbacks, or the system
> grows fan-out across agents with independent failure domains. Adding a case layer above
> the graph is not a revisit of this decision — it is a new one, and it belongs in its own
> record.

P3-D built the agent's half of a prior authorization: `POST /fhir/Claim/$submit` runs a
four-node graph (`intake`, `lookup`, `assess`, `dispose`) inline and answers `queued` when
the request needs a clinician. P3-E builds what happens next: a queue, a seven-day or
72-hour clock, a reviewer's signed determination, and `Claim/$inquire`. P3-D proposed doing
that inside the graph, with a `review` node that calls `interrupt()` and a route that
resumes the thread with `Command({ resume })`.

That proposal was probed twice: on `@langchain/langgraph` 0.4.10 on 2026-09-26 (P3-E's
Problem section), and again on 1.4.18 on 2026-10-08, after P5-C's upgrade, with the same
throwaway graph and `MemorySaver`. Both versions behaved identically:

- A second `Command({ resume })` on a finished thread returns the old state and discards the
  new value, with no error.
- A resume on a thread id that never existed succeeds, returns an empty state, and leaves a
  checkpoint for that id in `list({})`.
- Two concurrent resumes of one paused thread both succeed, each caller is told its own
  value was applied, and the stored state holds the second.
- With no checkpointer the node throws `GraphValueError: No checkpointer set`, and the
  service compiles without one on the unconfigured memory axis.
- `interrupt<I = unknown, R = any>` still types the resumed value as `any`, so a node that
  writes it into a channel passes P3-A's `Node` alias whatever it is.

A thread paused for up to seven days, waiting for an HTTP callback from a clinician, is the
revisit trigger ADR 0001 names. So the choice was between revisiting 0001 and adding the
case layer it anticipates.

## Decision

**The case lives in a table above the graph, and the graph stays linear.**

- **LangGraph owns the agent's run on a request**, from `intake` to `dispose`. The run
  finishes inside the `$submit` exchange. Its checkpoints under `thread_id = caseId` are the
  record of what the agent read and found, which is what P3-B's replay reads.
- **The case layer owns the queue, the clock, the overdue sweep and the determination.** It
  is the `prior_auth_cases` table in `packages/memory-core/src/cases/`, written through
  `CaseRepository`, and a sweep on an interval. It is not a workflow engine. No thread is
  paused or resumed, and no code under `apps/agent-service/src` calls `interrupt()` or
  constructs a `Command`.
- **The four silent cases have explicit answers.** An unknown case is `404`. A decided case
  is `409`, or the stored response on a byte-identical retry. Concurrent determinations on
  one case give one success and conflicts, because `decide` locks the row
  (`SELECT … FOR UPDATE` in Postgres, a per-case mutex in the in-process store). There is no
  checkpoint to fork, because nothing resumes.
- **The determination never enters agent state.** The route parses it with
  `@repo/determination`'s schemas, mints a denial with `attestAdverseDetermination`, and
  stores it on the case row. There is no `any` between the clinician and the record.

## Consequences

**What this buys.** The graph keeps the properties ADR 0001 chose it for, and P3-B's replay
keeps its premise of a linear run with no interrupts. A paused thread would have had to
survive deploys and dependency upgrades that P5-C's cross-version check did not cover. A
row needs only its migration. The queue has a due-date column to sort on, and a partial
index on `(decision_due_by, received_at, case_id) WHERE status = 'pended'` serves it, where
a checkpoint scan would read every super-step of every run to find the pended ones.

**What it costs.** The case table is a second record of each request beside the
checkpoints. Its `request` and `disposition` columns duplicate what the checkpoint holds,
including the model's rationale, which is member data on a real deployment. That is on the
"Before real data" list in `.context/conventions.md`. The unconfigured memory axis gets a
volatile in-process store that loses every case on restart, and boot says so at `warn`
(`review.cases.volatile`).

**What it does not give.** A durable timer that acts. The overdue sweep flags a case and
does nothing else: auto-denial at the deadline is what P3-A forbids, and § 422.568(f)
already makes a missed deadline appealable by the member. There is no retry with backoff
and no compensation. Nothing in this layer needs them yet.

**Revisit when** the case needs a timer that acts, or a wait that must survive a crash
mid-step. Two are in view: forwarding an affirmed denial to the independent review entity
(§ 422.590, P3-F's territory), and a request for information that stops the clock
(§ 422.568(b)(2)), which P3-E leaves unmodelled. A durable-execution engine earns its
operational cost at that point, and this table is what it would replace. Running that
engine and LangGraph at the same layer would still be the incoherence ADR 0001 describes:
the engine would own the case and invoke the graph as one step.
