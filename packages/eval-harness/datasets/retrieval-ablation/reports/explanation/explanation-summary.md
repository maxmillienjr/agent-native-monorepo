# Graph explanation: path precision and recall

- **Axes:** memory `live`, model `none`, embeddings `none`
- **Dataset sha256:** `46e6f4b5bdbee3641de2bc9f04169e5f1dd77452e4700e019d7b53fe64617bdc`
- **Labels sha256:** `582b43de6e0e9a9508ae4387cd5ee51a4b1a48d5c4c450d16da3c93ed7252334` (`explanation-labels.json`)
- **Pairs:** 201 (paraphrase 50, relational 50, entity-distractor 50, no-entity 51)
- **Configuration:** at most 3 paths per fact, at most 2 hops, bootstrap 10000 resamples seed 24301, 95% percentile
- **Run:** 2026-10-08T19:07:30.608Z to 2026-10-08T19:07:34.261Z

## Construction check

`explain·per-fact·oracle` on relational pairs: recall@3 1.000 against a bound of 1.000: **passed**. The explainer was not changed after the first run.

## Conditions

| Condition | Role | Graph shape | Question concepts |
| --- | ---: | ---: | ---: |
| `explain` | decisive | `reflect` | `linker` |
| `explain·oracle` | diagnostic | `reflect` | `gold` |
| `explain·per-fact` | diagnostic | `per-fact` | `linker` |
| `explain·per-fact·oracle` | construction check | `per-fact` | `gold` |

### paraphrase

| Condition | Pairs | Precision@3 | Recall@3 | Hit@1 | n P / R | sd P / R | To resolve P / R | Abstained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `explain` | 50 | 0.543 [0.473, 0.620] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.269 / 0.000 | 149 / 1 | 0.0% |
| `explain·oracle` | 50 | 0.543 [0.473, 0.620] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.269 / 0.000 | 149 / 1 | 0.0% |
| `explain·per-fact` | 50 | 0.970 [0.930, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.120 / 0.000 | 1 / 1 | 0.0% |
| `explain·per-fact·oracle` | 50 | 0.970 [0.930, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.120 / 0.000 | 1 / 1 | 0.0% |

### relational

| Condition | Pairs | Precision@3 | Recall@3 | Hit@1 | n P / R | sd P / R | To resolve P / R | Abstained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `explain` | 50 | 0.637 [0.553, 0.723] | 1.000 [1.000, 1.000] | 0.760 [0.640, 0.860] | 50 / 50 | 0.317 / 0.000 | 21 / 1 | 0.0% |
| `explain·oracle` | 50 | 0.637 [0.553, 0.723] | 1.000 [1.000, 1.000] | 0.760 [0.640, 0.860] | 50 / 50 | 0.317 / 0.000 | 21 / 1 | 0.0% |
| `explain·per-fact` | 50 | 0.990 [0.970, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.071 / 0.000 | 1 / 1 | 0.0% |
| `explain·per-fact·oracle` | 50 | 0.990 [0.970, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.071 / 0.000 | 1 / 1 | 0.0% |

### entity-distractor

| Condition | Pairs | Precision@3 | Recall@3 | Hit@1 | n P / R | sd P / R | To resolve P / R | Abstained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `explain` | 50 | 0.410 [0.373, 0.453] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.144 / 0.000 | 10 / 1 | 0.0% |
| `explain·oracle` | 50 | 0.410 [0.373, 0.453] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.144 / 0.000 | 10 / 1 | 0.0% |
| `explain·per-fact` | 50 | 0.970 [0.930, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.120 / 0.000 | 1 / 1 | 0.0% |
| `explain·per-fact·oracle` | 50 | 0.970 [0.930, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 50 / 50 | 0.120 / 0.000 | 1 / 1 | 0.0% |

### no-entity

| Condition | Pairs | Precision@3 | Recall@3 | Hit@1 | n P / R | sd P / R | To resolve P / R | Abstained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `explain` | 51 | — | — | — | 0 / 0 | — / — | — / — | 100.0% |
| `explain·oracle` | 51 | 0.000 [0.000, 0.000] | — | — | 12 / 0 | 0.000 / — | 1 / — | 76.5% |
| `explain·per-fact` | 51 | — | — | — | 0 / 0 | — / — | — / — | 100.0% |
| `explain·per-fact·oracle` | 51 | 0.000 [0.000, 0.000] | — | — | 12 / 0 | 0.000 / — | 1 / — | 76.5% |

### Relational diagnostics

| Condition | A among question concepts | Length-0 path returned | Length-0 path first |
| --- | ---: | ---: | ---: |
| `explain` | 50 / 50 | 12 / 50 | 12 / 50 |
| `explain·oracle` | 50 / 50 | 12 / 50 | 12 / 50 |
| `explain·per-fact` | 50 / 50 | 0 / 50 | 0 / 50 |
| `explain·per-fact·oracle` | 50 / 50 | 0 / 50 | 0 / 50 |

## Decision rule

Pre-registered in P2-D, on `explain`, relational stratum: `good` if recall@3's 95% lower bound is at least 0.7 and precision@3's is at least 0.5; `not good` if either upper bound is below its threshold; otherwise `inconclusive`.

| Metric | n | Mean | 95% interval | sd | Threshold | Pairs to resolve |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Recall@3 | 50 | 1.000 | [1.000, 1.000] | 0.000 | 0.70 | — |
| Precision@3 | 50 | 0.637 | [0.553, 0.723] | 0.317 | 0.50 | — |

**Stage 1: good.**

**Stage 2: did not run** — stage 1 is good; stage 2 is scheduled separately against the free-tier quota and has not run. It made 0 `generateContent` calls.

**Outcome: decided by stage 2.**
