# 0005 · Record at the decision seam rather than at the transport

**Status:** accepted
**Date:** 2026-09-10

## Context

Every evaluation trial costs a live model call and there is no path that does not.
`RunsService.getDeps` picks the Gemini dependency set when `GOOGLE_API_KEY` is set and a
canned stub set otherwise; a trial therefore either spends quota or measures the half of
the system that cannot fail. One live trial of `memory-recall-001` makes three
`generateContent` calls and eighteen `embedContent` calls, and the free tier allows twenty
`generateContent` requests a day — so the suite's default of five trials over two tasks has
never run on the live model axis.

Record and replay is the standard answer, and the standard shape of it — VCR, Polly.js,
nock — records at the transport: the HTTP request and the HTTP response, matched on method,
URL and body. The interesting part of the decision is not whether to have a replay layer
but **at what level it records**, because that choice decides what the replayed suite
stops measuring.

Two facts about this repository bear on it directly. `createGeminiEmbedder` puts the API
key in an `x-goog-api-key` header (`gemini-embedder.ts:34`), and the cassette set is
committed to a repository that is read in public. And `gemini-embedder.ts` exists at all
because the pinned `@langchain/google-genai` has no output-dimension parameter — the
version that does needs the `@langchain/core` upgrade P5-C owns, so the client under these
calls is known to be changing.

## Decision

Cassettes record the **decision seam**: the five functions in `ModelDeps` that cost a model
call, plus tool execution.

| Seam                      | Request                    | Response                      |
| ------------------------- | -------------------------- | ----------------------------- |
| `plan.callLlm`            | system prompt, user prompt | content, token counts         |
| `act.selectTool`          | plan text, tool names      | `{toolName, input}` or `null` |
| `act.tool`                | tool name, input           | tool output                   |
| `distill.extractEntities` | conversation context       | `Extraction`                  |
| `embed`                   | text                       | 768 floats                    |

Everything else in a run is a function of those. The graph's one conditional edge branches
on what `act.selectTool` returned; `plan`'s prompt is built from `state.messages` and
`state.retrievedContext`; every `embed` argument is the user's message or a fact from the
recorded extraction. Freeze the table and the run is determined.

A decision is looked up by a sha256 over canonical JSON of `{ seam, label, request }`, and
the player holds one queue per key and consumes it in recorded order — so two identical
requests in one run are two entries, and `IO_RETRY` re-running a throwing node replays as
the recorded error followed by the recorded success.

Replay substitutes the model axis and **only** the model axis. A replayed trial still needs
Postgres and Neo4j, still resets and re-seeds, and still has its outcome read out of the
stores by `PgNeo4jMemoryInspector`. Replaying the store reads too would leave the outcome
graders with nothing real to assert against, and those are the graders P1-A exists for.
Containers are free; model calls are not.

## Consequences

**A cassette carries no credential.** A transport recording captures the `x-goog-api-key`
header; a decision recording never sees it. For a repository read in public that is the
deciding argument, and it is belt-and-braces rather than luck: a redaction pass runs over
every recorded request and error before it is written, and a unit test walks the committed
set for anything matching `AIza[0-9A-Za-z_-]{35}`.

**It survives the client.** P5-C replaces the pinned `@langchain/google-genai`, and
`gemini-embedder.ts` exists because of that pin. A transport cassette is invalidated by an
SDK upgrade that changes a header or a URL shape; a decision cassette is not.

**It covers a tool that is not HTTP.** `Tool.execute` is `(input: unknown) =>
Promise<unknown>`, and P4-C's registry will hold tools that are not network calls at all.
A transport recorder cannot see them.

**The cost, stated plainly: replay exercises the graph, not the client.** The defect class
this makes invisible is everything between the wire and the value the seam returns — a
defect in `parseExtraction`, in `l2Normalize`, or in the `embedContent` response check at
`gemini-embedder.ts:49-57` is invisible under replay, because the recorded value is the
parsed one. That is the exact class of defect that made P2-A ship broken twice. The nightly
live tier is what covers it, and P1-C owns keeping that tier alive; a replayed suite is not
a substitute for it and must never be described as one.

**A prompt edit invalidates the set, and that is the design working.** Change the string at
`plan.node.ts:6` or `extraction.ts:3-4` and the request hash moves, every replay misses,
and the set has to be re-recorded against a live key. The alternative — keying on a
normalized shape so a prompt edit still replays — returns the old answer for a new prompt
and calls it a pass. The mitigation is ergonomic: `CassetteMissError` prints a diff of the
recorded request against the actual one, and `EVAL_CASSETTE_MODE=record` regenerates.

**A replayed number is a frozen sample.** `pass^k` over replayed trials reproduces the
recorded run's `pass^k` and will keep reproducing it until the set is re-recorded. It
catches a change in the graph, in the prompts' effect on branching, in the memory writes,
in the graders and in the retrieval path. It cannot catch the model getting worse — that is
P1-E — and it cannot catch the client breaking, as above. This is why `ModelAxis` gains
`replay` as a third value rather than replay being made to look like `live`, and why
`SuiteReport.replay` names the set's `recordedAt` and `gitSha` in all three reports.

**It is not the same mechanism as audit-grade replay.** Reconstructing what a past
production run did, from its checkpoints, is P3-B: a different artifact (the checkpointer's
rows, written by a run nobody planned to replay) answering a different question (what did
this run do) with different fidelity requirements. A cassette is recorded deliberately,
holds only the decisions, and answers "does the graph still behave this way".

**Determinism became a prerequisite.** Both semantic readers produced ties by construction
and an untied order reaches `plan`'s prompt through `rrfMerge`, so a cassette keyed on that
prompt was built on a prompt that could change between two trials of identical seeded data.
Both readers now break the tie on the content hash (`3b696d5`), and the set was recorded
after that fix — recorded before it, a passing replay would have proved the dataset never
produced a tie rather than that the ordering is deterministic.
