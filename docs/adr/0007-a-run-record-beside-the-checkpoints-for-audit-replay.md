# 0007 · A run record beside the checkpoints, for audit replay

**Status:** accepted
**Date:** 2026-10-08

## Context

An auditor or an appeal asks what the agent saw and decided in one run, months after it
ran. [ADR 0001](0001-langgraph-over-a-durable-execution-engine.md) named the checkpointer
"the substrate P3-B's audit replay is built on", and
[ADR 0005](0005-decision-seam-rather-than-transport-for-replay.md) described P3-B's
artifact as "the checkpointer's rows, written by a run nobody planned to replay".

P3-B measured that substrate before building on it. Two `POST /runs` on fresh stores each
left nine checkpoints, readable through `getStateHistory`. They do not hold the request
body, only the fields `ingress` copied into state. They do not hold a retry: a node that
threw once and then succeeded under its retry policy leaves a history identical to a
first-attempt success, and every attempt of an I/O node is a model call. They do not say
which code ran, because the image carries no `.git`. They hold the retrieved candidates
but not the query that produced them, and the store cannot be asked again: a second run of
the same request retrieved the first run's fact. And memory cannot say what a run wrote,
because `episodes`, `semantic_facts` and the `:Fact` nodes keep whichever run wrote first.

So the rows are a trace of the run, not its inputs, and a trace cannot be replayed alone.

## Decision

**Persist the run's arguments beside its trace, and replay the function against the
trace.**

Given the code at a commit, a run is determined by the request, the answers at the decision
seam and the retrieval reads. The checkpoint history is that function's trace. Every run on
the configured memory axis therefore writes a **run record** to Postgres, in
`run_records` and `run_decisions` beside the checkpoint tables:

- a header: the body as received, the commit, the chat and embedding models, which axis
  served the model half, and when the request arrived;
- one row per decision, appended as it resolves rather than buffered, at ADR 0005's seams
  plus one more, `memory.retrieve`. A retried call is two rows, the error and then the
  value.

`audit:replay <runId>` refuses unless the running build is the recorded commit. It rebuilds
the graph with every input served from the record, re-executes it on an in-memory saver,
and compares every super-step's `next` and channel values with the recorded history. It
exits 0 only if every checkpoint matches, the counts match and every recorded decision was
asked for.

**The record reuses the cassette's decision, and is not a cassette.** The seam, the
request builders, the canonical hash, the queue-per-key replay semantics, the float32
vector codec and the key redaction are shared, through one module the service and the
evaluation both record through. The header is not shared. A cassette's names an
evaluation trial and pins both axes to `live`, and a production run on the stub model is
still a run that happened. The sink is not shared either: a cassette is a committed file
written when the trial ends, and a record is rows written as the run goes, because the run
an auditor most wants is the one that crashed.

| Question         | Cassette (ADR 0005)                         | Run record (this record)                         |
| ---------------- | ------------------------------------------- | ------------------------------------------------ |
| What it answers  | Does today's graph still behave this way?   | What did run X do, and is its record complete?   |
| Written when     | Deliberately, `EVAL_CASSETTE_MODE=record`   | Every run on the configured memory axis          |
| Seams            | The model seams and the tool                | Those, plus `memory.retrieve`                    |
| Memory on replay | Live, reset and re-seeded; writes performed | Reads served from the record; writes captured    |
| Code on replay   | Whatever is checked out — that is the test  | The recorded commit, or refuse                   |
| Checked against  | Graders over the outcome                    | The recorded checkpoint history, step by step    |
| Contents         | Synthetic fixtures, read in public          | Whatever a caller sent: PHI in a real deployment |

**A cassette can never hold a retrieval, and a record always can.** Evaluation keeps
memory live, which is what gives its outcome graders something to read; that stays true.
The record's schema is the cassette's `DecisionSchema` widened by that one seam, so a
cassette parse still rejects a `memory.retrieve` decision.

**Replay runs at the recorded commit.** The prompts, the tool registry and the chat model
id are constants of the code, and the record names them only through the commit. Replaying
on the commit that wrote the history also means the LangGraph reading it is the one that
wrote it, so no cross-version checkpoint question arises. The image takes the commit as a
`GIT_SHA` build argument, and the release workflow tags it with the same string.

**The record lives in `memory-core`.** It is written with the service's own database role,
under the same migrator, beside tables that role already writes. It is not a memory tier,
and nothing a graph is given can read it. P3-C's ledger reaches the opposite placement for
the opposite reason: its writer must not have `UPDATE`.

**A record that cannot be written fails closed on the regulated path and open on the
chat path.** Review decided the split. A prior-authorization run returns a recommendation,
and a decision that cannot be recorded is not returned: `$submit` answers 503 with an
`OperationOutcome` and no `ClaimResponse`. A chat run completes, logs the failure, and its
record closes `partial`. Opening a record fails the run on both paths, before any work.

## Consequences

**Replay proves the record complete and consistent, and nothing more.** A match means no
unrecorded input moved any state transition, and the record and the checkpoints agree. It
does not mean either is unaltered: both are rows the service's credentials can rewrite,
and an edit made consistently to the decisions and the checkpoints passes. P3-C commits
each record to a hash chain for that. Replay also does not exercise the model client. A
defect between the wire and the seam is invisible here, as ADR 0005 says of cassettes, and
for an audit that is the right cut: the record holds what the agent acted on.

**An unrecorded input breaks replay loudly.** Replay constructs no model client and no store
client: the model half and retrieval are served from the record, `reflect`'s writers
capture, and the record and history are read through a read-only pool. A future node that
reads the clock into state, calls `Math.random` or reads a store outside the facade makes
replay diverge or miss, rather than quietly reading today's data. The mutation tests cannot
find an input nobody recorded. A new input is added the way `memory.retrieve` was: as a
seam.

**What a run wrote is derived, not read.** Replay re-executes `reflect` against capturing
writers, so the report lists the episodic turns, concepts, relationships and facts this run
asked to write, which the first-write-wins stores cannot attribute to it. The episodic
table keeps its semantics: an edited, re-sent turn is in the request of the run that sent
it.

**The schema is additive-only.** An old build has to read a record table a newer one
migrated, so a run-record migration adds nullable or defaulted columns and nothing else.
The enum-like columns carry no `CHECK` for that reason; Zod validates them in both
directions.

**The record holds whatever a caller sent.** The checkpoints already hold the messages and
the retrieved context, so this is the same class of data in more rows. In this repository it
is synthetic (ADR 0003). A deployment on real member data must encrypt these tables at
rest, log reads of them, give audit readers a separate read-only role, and set a retention
period that meets its record-keeping floor. Nothing here deletes a record; a prune command
would have to be an event in P3-C's ledger. The deploying covered entity owns all of it, and
`.context/conventions.md` lists it under "Before real data".

**It costs a write per decision.** A stub chat run records six rows. A trial replayed from
either committed cassette records twenty, 70 to 93 KB of decisions, most of it the
base64 embeddings. It is unbounded, beside checkpoints that are already unbounded. Each
append is awaited before the graph sees the answer, which adds a round trip per decision.

**Parallel branches would need a different comparison.** Both graphs have one path through
every super-step, so checkpoints are compared by position. A fan-out, such as P4-C's
approval gate or a `Send`, would have to compare by task id, and an `interrupt()` would
make one run two invocations on one thread. P3-E's case layer keeps both graphs linear.
