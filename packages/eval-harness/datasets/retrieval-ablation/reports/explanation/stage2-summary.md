# Graph explanation, stage 2: answers with and without the paths

- **Axes:** memory `live`, model `replay`, embeddings `recorded`
- **Dataset sha256:** `46e6f4b5bdbee3641de2bc9f04169e5f1dd77452e4700e019d7b53fe64617bdc`
- **Labels sha256:** `582b43de6e0e9a9508ae4387cd5ee51a4b1a48d5c4c450d16da3c93ed7252334`
- **Answers:** 76 of 76 recorded in `recorded/explanation-answers.json` (sha256 `48d503b6dae81ddf270928e0979f9f10786ed9aa1453651118323ee8d18d89b4`), on `gemini-2.5-flash`, over 6 invocation(s), 2026-11-05T20:32:06.144Z to 2026-11-09T13:51:14.343Z
- **Requests to the model host in this run:** 0
- **Configuration:** vector retrieval at topK 10, bootstrap 10000 resamples seed 24301, 95% percentile
- **Run:** 2026-11-09T13:51:53.554Z to 2026-11-09T13:51:57.835Z

## Graders

| Grader | without | with | with − without | 95% interval | sd | n |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `answer_key_present` (rule) | 0.895 | 0.816 | -0.079 | [-0.184, +0.026] | 0.359 | 38 |
| `bridge_named` (reported) | 0.947 | 0.842 | -0.105 | [-0.237, +0.000] | 0.388 | 38 |

## Decision rule

Pre-registered in P2-D: `met` if `answer_key_present` improves by at least +0.10 with the paths and the bootstrap's lower bound is above 0; otherwise `not met`. Status: every answer is recorded; the rule reads answer_key_present, with − without.

**Stage 2: not met.**

## Per query

| Query | Facts explained | Answer fact explained | Key without | Key with | Bridge without | Bridge with | Split across invocations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `relational-003` | 10 | yes | yes | yes | yes | yes | — |
| `relational-005` | 10 | yes | yes | yes | yes | yes | — |
| `relational-009` | 10 | yes | yes | no | yes | no | — |
| `relational-010` | 10 | yes | yes | no | yes | yes | — |
| `relational-011` | 10 | yes | yes | yes | yes | yes | — |
| `relational-012` | 10 | yes | yes | yes | yes | yes | — |
| `relational-013` | 10 | yes | yes | no | yes | no | — |
| `relational-014` | 10 | yes | yes | yes | yes | yes | — |
| `relational-015` | 10 | yes | yes | yes | yes | yes | — |
| `relational-016` | 10 | yes | yes | yes | yes | yes | 3, 4 |
| `relational-018` | 10 | yes | yes | yes | yes | yes | — |
| `relational-020` | 9 | yes | no | no | yes | no | — |
| `relational-021` | 10 | yes | yes | yes | yes | yes | — |
| `relational-022` | 10 | yes | yes | yes | yes | yes | — |
| `relational-023` | 10 | yes | yes | no | yes | no | 5, 6 |
| `relational-024` | 10 | yes | yes | yes | yes | yes | — |
| `relational-025` | 10 | yes | no | no | yes | no | — |
| `relational-026` | 10 | yes | yes | yes | yes | yes | — |
| `relational-027` | 10 | yes | yes | yes | yes | yes | — |
| `relational-028` | 10 | yes | yes | yes | yes | yes | — |
| `relational-029` | 10 | yes | yes | yes | yes | yes | — |
| `relational-030` | 10 | yes | yes | yes | yes | yes | — |
| `relational-031` | 10 | yes | yes | yes | yes | yes | — |
| `relational-032` | 10 | yes | yes | yes | yes | yes | — |
| `relational-033` | 10 | yes | yes | yes | yes | yes | — |
| `relational-034` | 10 | yes | yes | yes | yes | yes | — |
| `relational-035` | 10 | yes | yes | yes | yes | yes | — |
| `relational-036` | 10 | yes | yes | yes | yes | yes | — |
| `relational-038` | 10 | yes | no | yes | no | yes | — |
| `relational-039` | 10 | yes | yes | yes | yes | yes | — |
| `relational-040` | 10 | yes | yes | yes | yes | yes | — |
| `relational-041` | 10 | yes | yes | yes | yes | yes | — |
| `relational-042` | 10 | yes | yes | yes | yes | yes | — |
| `relational-046` | 4 | yes | no | no | no | no | — |
| `relational-047` | 9 | yes | yes | yes | yes | yes | — |
| `relational-048` | 7 | yes | yes | yes | yes | yes | — |
| `relational-049` | 4 | yes | yes | yes | yes | yes | — |
| `relational-050` | 4 | yes | yes | yes | yes | yes | — |
