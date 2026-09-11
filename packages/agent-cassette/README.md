# `@repo/agent-cassette`

Decision-level record and replay for evaluation trials: the cassette format, the request
hash, the vector codec, the recorder and the player.

Its only runtime dependency is `zod`, and nothing in this repository. That is a constraint
rather than an accident — the moment it imports `@repo/eval-harness` for an axis type or
`@repo/memory-core` for an embedding width it stops being liftable and becomes a second
place the eval types live. Everything it needs to know about the running configuration
arrives as data: the header carries `embeddingDimensions`, and the axis check takes the
axes as an argument.

## What it records

Not HTTP traffic. A cassette holds the decisions a run made at the seams where it spends
money:

| Seam                      | Request                    | Response                      |
| ------------------------- | -------------------------- | ----------------------------- |
| `plan.callLlm`            | system prompt, user prompt | content, token counts         |
| `act.selectTool`          | plan text, tool names      | `{toolName, input}` or `null` |
| `act.tool`                | tool name, input           | tool output                   |
| `distill.extractEntities` | conversation context       | `Extraction`                  |
| `embed`                   | text                       | 768 floats                    |

ADR 0005 argues that choice against the transport-level alternative and names what it stops
measuring. The short version: a decision cassette carries no credential and survives the
client being replaced, at the cost of not exercising the client — a defect in
`parseExtraction`, in `l2Normalize` or in the `embedContent` response check is invisible
under replay, because the recorded value is the parsed one.

Lookup is a sha256 over canonical JSON of `{ seam, label, request }`, and the player holds
one queue per key and consumes it in recorded order. Two identical requests in one run are
two entries; when a queue empties that is a miss, not a reuse. It is what makes a retry
replayable — `IO_RETRY` re-runs a throwing node with the same input, so attempt 1's error
and attempt 2's success are two entries under one hash and replay reproduces both.

Embeddings are stored as base64 float32. Measured over 768 dimensions a vector is 16,345
bytes as a JSON float array and 4,096 as base64 float32, and the two committed trials make
fourteen and seven embedding calls. The precision is not lost twice: `semantic_facts.embedding` is
`vector(768)` and pgvector's `vector` is an array of `float4`, so the database would round
the same values on the way in.

## The committed cassettes

They live in `@repo/eval-harness`, next to the dataset they were recorded against:
`packages/eval-harness/datasets/memory-recall/cassettes/<taskId>.trial-<n>.json`. This
package resolves nothing about that path — a test here scans the directory by relative path
rather than importing `EVAL_DATASETS_DIR`, for the dependency reason above.

<!-- RECORDED-SET:START -->

| Cassette                         | Axes                        | Recorded                 | Decisions                                 | Size    |
| -------------------------------- | --------------------------- | ------------------------ | ----------------------------------------- | ------- |
| `memory-recall-001.trial-0.json` | model `live`, memory `live` | 2026-09-10, at `021c6f2` | 3 model calls, 14 embeddings              | 93.9 KB |
| `tool-use-001.trial-0.json`      | model `live`, memory `live` | 2026-09-10, at `021c6f2` | 5 model calls, 3 tool calls, 7 embeddings | 48.3 KB |

One trial of each task, not five. Recording five would cost about forty
`generateContent` calls against a 20-request daily free tier; P1-C owns the pipeline that
would want them. The recording run itself passed every grader on both tasks, which is the
only 1 × 2 live-axis result this repository has.

<!-- RECORDED-SET:END -->

**Every cassette is recorded on model `live` / memory `live`, and cannot be anything else.**
`CassetteHeaderSchema` pins both axes to those literals, so `CassetteRecorder` refuses a
header that says otherwise. A recording of the canned stub set would be schema-valid,
replay cleanly, and measure nothing — a fake of a fake, with an artifact committed to make
it durable.

**A replayed `pass^k` is a frozen sample, not a reliability measurement.** It reproduces the
recorded run's result and will keep reproducing it until the set is re-recorded. It catches
a change in the graph, in the prompts' effect on branching, in the memory writes, in the
graders and in the retrieval path. It cannot catch the model getting worse (P1-E) and it
cannot catch the client breaking (the nightly live tier, P1-C). Read a replayed rate as a
regression test that happens to be spelled as a percentage.

**When to re-record** is in `.context/conventions.md`, next to the rest of the eval
conventions. A prompt edit is the common case: the request hash moves, every replay misses,
and `CassetteMissError` prints a diff of the recorded request against the actual one.

## Using it

```ts
import { CassetteRecorder, CassettePlayer, type Deck } from '@repo/agent-cassette';

const deck: Deck = new CassetteRecorder({ header, sink: write });
const value = await deck.resolve({ seam: 'embed', request: { text } }, () => embed(text));
```

`CassettePlayer` implements the same interface and never calls the thunk. The wiring that
turns a `Deck` into the model half of a dependency set is
`apps/agent-service/src/eval/cassette-deps.ts`, and reading `EVAL_CASSETTE_MODE` is the
harness's — that separation is what keeps this package's dependency list one line long.

## Tests

`yarn workspace @repo/agent-cassette test:unit`. They cover the canonical hash, the vector
codec, redaction, the miss diff, the three incompatibility refusals, the retry replay, and
a scan of the committed cassette directory for anything key-shaped.
