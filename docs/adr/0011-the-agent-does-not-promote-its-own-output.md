# 0011 · The agent does not promote its own output to semantic memory

**Status:** accepted
**Date:** 2026-10-08
**Decided:** 2026-09-26, at the review of [P4-B](../prd/P4-B-memory-poisoning-red-team.md)

## Context

`reflect` is the only writer to semantic memory, and it writes what `distill` extracted.
Until this record, `distill` handed the model every message in the run's state
(`distill.node.ts:37-38` at `69f3787`). That includes the assistant's turn, which `plan`
appends with the answer it wrote from a prompt holding every retrieved candidate.

Two things follow, and the second is why this is a security decision and not a tidiness
one.

**Semantic memory mostly held the model's own claims.** In the committed
`memory-recall-001` recording, the user's turn asks a question and asserts nothing. Every one
of the 13 facts `distill` extracted restates the assistant's plan (P4-B, "Problem").

**Retrieval could launder a fact into a session.** A fact in `plan`'s prompt that the answer
paraphrases is extracted again, under a new content hash, and `reflect` writes it into the
requesting session. From then on the session-scoped vector search returns it as that
session's own. Any retrieval defect that let a fact cross a boundary would therefore become
permanent, and a fact injected into one session would be restated as new facts in every
later run of it. OWASP's ASI06 Memory & Context Poisoning asks for exactly the opposite:
"validate anything written to persistent memory". MITRE ATLAS files the countermeasure as
AML.M0031 Memory Hardening.

P4-B's red-team case `rt-002` exercises that path: a poisoned fact in the victim's own
session, a benign question, and a grader on the extraction `reflect` is handed.

## Decision

**`distill` reads the user's turns and nothing else.** `distillNode` filters
`state.messages` to `role === 'user'` before it builds the extraction context. The
assistant's turn is still written to `episodes`, because it is history. It is not a source of
facts. With no user turn, `distill` makes no model call and returns an empty extraction.

This is the deterministic form of "validate what is written to memory". It does not ask the
model to decide which claims came from the user and which from itself. A canary that reached
only `plan`'s prompt cannot reach `distill`'s, so the laundering path is closed by
construction rather than by a judgement an attacker can aim at.

**After this change semantic memory learns only what a user said.**

## What it gives up

- **Facts the model contributed.** An answer that is right, and that a later run would have
  benefited from recalling, is not remembered. Semantic memory is no longer a cache of the
  model's knowledge, only of the users'.
- **Context for the user's own words.** The extraction sees the user's lines without the
  answers between them. In a multi-turn history, "yes, use that one" loses its referent, and
  the model may extract less, or extract it wrongly.
- **Tool results restated in an answer.** Today no tool output reaches a prompt (P4-C), so
  nothing is lost yet. Once P4-C feeds tool results to `plan`, a fact a tool returned and the
  answer restated will not be remembered. If that should be remembered, it needs a path of
  its own with its provenance attached, decided in P4-C, not a reversal of this record.
- **Validation of what a user says.** This is a provenance rule, not a truth check. A user's
  false claim is still extracted and written, in that user's session. `rt-003` shows the
  case: an attacker's own turn is written to the attacker's memory. Session scope on
  retrieval, which P4-B's M2 makes mandatory, is what keeps it there. Access to a session is
  a separate question: `sessionId` comes from the client, and authentication is CTL-ACC-01's,
  owned by P5-A.
- **A positive control may fail.** `memory-recall-001` asserts `mergedConceptsMin: 1`. With
  only the question to read, the model may extract no entity. If the re-recording shows that,
  the task changes to state a fact in its user turn, in the pull request that re-records it.
  The threshold is not lowered.

## Alternatives considered

**Provenance labels.** `distill` labels each fact with the turn it came from, and `reflect`
stores the label and refuses to promote assistant-sourced facts. It keeps the option of
promoting them later under a rule. Rejected at P4-B's review: a label is a model judgement
standing between an attacker and long-term memory, and the attacker writes the text the
model judges. It would also add a field to both stores and a migration.

**Per-session fact identity.** Keying facts on `(session_id, content_hash)` instead of the
hash alone. Not taken; see below.

## The first-writer rule, and what reopens it

Both stores key a fact on its content hash alone. pgvector upserts on `content_hash`, and the
graph sets a `:Fact`'s episode only on create. **The first session to state a text owns it.**
A later session that states the same text writes no row, and its own session-scoped search
cannot return it.

This loses recall and poisons nothing. It was observed, not only argued, on 2026-10-08, in a
local run on model `stub` and memory `live` with `rt-003`'s axis requirement lifted. The stub
extracts one fixed sentence on every run. `rt-001`'s run wrote it under session `…c10`.
`rt-003`'s graded run, in session `…c30`, extracted the same sentence and wrote zero
`semantic_facts` rows for its run; the row stayed under `…c10`, where a search scoped to
`…c30` cannot reach it. On the live model the collision needs two sessions to produce the
same sentence, which a paraphrase avoids and a short factual claim may not.

Per-session identity would fix it. It is a migration in both stores, a composite Neo4j
constraint and an amendment to ADR 0004's fusion key, and it is not needed to close the
poisoning path, so P4-B did not take it. When P4-B's review decided this, the cost it
weighed was M1's: scoping the graph by session would have made the same loss appear on the
graph path. ADR 0009 took the graph out of retrieval and M1 moved to P2-D, so the loss lives
on the vector path alone today, and P2-D inherits the graph half with M1.

**What reopens it.** A measured recall loss on any task that traces to the first-writer
rule — a positive control or a capability task failing because a session could not retrieve
a fact it stated, after another session stated it first. That opens per-session identity as
a PRD of its own. It is not patched inside the task that found it.

## Consequences

- Every cassette recorded before this change misses at `distill.extractEntities`, because
  the extraction request changed. `memory-recall-001` and `tool-use-001` have to be
  re-recorded, and the replay baseline regenerated, before P4-B ships; until then the replay
  tier aborts on the miss and names it.
- `.context/architecture.md` says `distill` reads the user's turns only, and P4-B's red team
  (`EVAL_SUITE=red-team`) carries `rt-002` as the regression test for this record.
- CTL-MEM-02 in `governance/controls.yaml` cites this record's test,
  `distill.node.test.ts`.
