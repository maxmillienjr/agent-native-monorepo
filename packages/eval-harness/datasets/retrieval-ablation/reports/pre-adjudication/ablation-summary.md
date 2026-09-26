# Retrieval ablation: graph, vector, hybrid

- **Axes:** memory `live`, embeddings `recorded`
- **Embeddings:** `gemini-embedding-001` at 768 dimensions, recorded 2026-09-26T19:16:26.485Z at `c72407e5032b3b84cbd3837f98422082d3ed0416`
- **Dataset sha256:** `46e6f4b5bdbee3641de2bc9f04169e5f1dd77452e4700e019d7b53fe64617bdc`
- **Dataset:** 52 episodes, 335 facts (137 answer no query), 200 queries (paraphrase 50, relational 50, entity-distractor 50, no-entity 50)
- **Configuration:** topK 10, hopDepth 2 (diagnostics at 1, 2, 3), RRF k 60, bootstrap 10000 resamples seed 24301, 20 tie salts
- **Vector search:** exact — the plan below does not use the HNSW index (ADR 0006); it scans every row of the session and sorts, and every latency here is for that
- **Seed linker:** produced ids for 150 of 200 queries; 0 produced an id that is a concept in the graph
- **Labels:** pre-registered only; the pooled candidates have not been adjudicated

## Primary table — the deployed path, pre-registered labels

Overall, over all queries (unweighted). The per-stratum tables below are the ones to trust.

| Condition | R@1 | R@3 | R@5 | R@10 | nDCG@1 | nDCG@3 | nDCG@5 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `vector` | 0.757 | 0.855 | 0.890 | 0.940 | 0.760 | 0.815 | 0.829 | 0.845 | 0.815 |
| `graph` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid` | 0.757 | 0.855 | 0.890 | 0.940 | 0.760 | 0.815 | 0.829 | 0.845 | 0.815 |

### paraphrase

| Condition | R@1 | R@3 | R@5 | R@10 | nDCG@1 | nDCG@3 | nDCG@5 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `vector` | 0.980 | 1.000 | 1.000 | 1.000 | 0.980 | 0.993 | 0.993 | 0.993 | 0.990 |
| `graph` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid` | 0.980 | 1.000 | 1.000 | 1.000 | 0.980 | 0.993 | 0.993 | 0.993 | 0.990 |

### relational

| Condition | R@1 | R@3 | R@5 | R@10 | nDCG@1 | nDCG@3 | nDCG@5 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `vector` | 0.100 | 0.440 | 0.560 | 0.760 | 0.100 | 0.294 | 0.343 | 0.407 | 0.297 |
| `graph` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid` | 0.100 | 0.440 | 0.560 | 0.760 | 0.100 | 0.294 | 0.343 | 0.407 | 0.297 |

### entity-distractor

| Condition | R@1 | R@3 | R@5 | R@10 | nDCG@1 | nDCG@3 | nDCG@5 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `vector` | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| `graph` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid` | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

### no-entity

| Condition | R@1 | R@3 | R@5 | R@10 | nDCG@1 | nDCG@3 | nDCG@5 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `vector` | 0.950 | 0.980 | 1.000 | 1.000 | 0.960 | 0.973 | 0.980 | 0.980 | 0.974 |
| `graph` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid` | 0.950 | 0.980 | 1.000 | 1.000 | 0.960 | 0.973 | 0.980 | 0.980 | 0.974 |

## Decision rule

Pre-registered in P2-B: `hybrid` against the better of `vector` and `graph` on Recall@10 over all queries, pre-registered labels. It earns its keep at Δ ≥ +0.05 with the interval's lower bound above 0; it does not if the upper bound is below +0.05; otherwise inconclusive.

| Comparison | System | Better baseline | Δ Recall@10 | 95% interval | σ | n to clear margin | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| primary | `hybrid` | `vector` | +0.000 | [0.000, 0.000] | 0.000 | — | pending adjudication |
| diagnostic: store without the linker | `hybrid·oracle` | `vector` | -0.145 | [-0.195, -0.095] | 0.367 | 14 | pending adjudication |
| diagnostic: per-fact MENTIONS (not pre-registered) | `hybrid·oracle·per-fact` | `vector` | -0.145 | [-0.195, -0.095] | 0.367 | 14 | pending adjudication |

## Diagnostic table — pre-registered labels

| Condition | R@1 | R@3 | R@5 | R@10 | nDCG@1 | nDCG@3 | nDCG@5 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `graph@hop1` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid@hop1` | 0.757 | 0.855 | 0.890 | 0.940 | 0.760 | 0.815 | 0.829 | 0.845 | 0.815 |
| `graph@hop3` | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid@hop3` | 0.757 | 0.855 | 0.890 | 0.940 | 0.760 | 0.815 | 0.829 | 0.845 | 0.815 |
| `graph·oracle@hop1` | 0.040 | 0.135 | 0.215 | 0.385 | 0.040 | 0.093 | 0.125 | 0.180 | 0.119 |
| `hybrid·oracle@hop1` | 0.388 | 0.570 | 0.665 | 0.795 | 0.390 | 0.494 | 0.533 | 0.577 | 0.508 |
| `graph·oracle` | 0.040 | 0.135 | 0.215 | 0.385 | 0.040 | 0.093 | 0.125 | 0.180 | 0.119 |
| `hybrid·oracle` | 0.388 | 0.570 | 0.665 | 0.795 | 0.390 | 0.494 | 0.533 | 0.577 | 0.508 |
| `graph·oracle@hop3` | 0.040 | 0.135 | 0.215 | 0.385 | 0.040 | 0.093 | 0.125 | 0.180 | 0.119 |
| `hybrid·oracle@hop3` | 0.388 | 0.570 | 0.665 | 0.795 | 0.390 | 0.494 | 0.533 | 0.577 | 0.508 |
| `graph·oracle·per-fact@hop1` | 0.090 | 0.215 | 0.360 | 0.530 | 0.090 | 0.159 | 0.219 | 0.274 | 0.197 |
| `hybrid·oracle·per-fact@hop1` | 0.477 | 0.680 | 0.750 | 0.795 | 0.480 | 0.596 | 0.624 | 0.638 | 0.588 |
| `graph·oracle·per-fact` | 0.090 | 0.215 | 0.360 | 0.530 | 0.090 | 0.159 | 0.219 | 0.274 | 0.197 |
| `hybrid·oracle·per-fact` | 0.477 | 0.680 | 0.750 | 0.795 | 0.480 | 0.596 | 0.624 | 0.638 | 0.588 |
| `graph·oracle·per-fact@hop3` | 0.090 | 0.215 | 0.360 | 0.530 | 0.090 | 0.159 | 0.219 | 0.274 | 0.197 |
| `hybrid·oracle·per-fact@hop3` | 0.477 | 0.680 | 0.750 | 0.795 | 0.480 | 0.596 | 0.624 | 0.638 | 0.588 |

Recall@10 per stratum, every condition:

| Condition | R@10 paraphrase | R@10 relational | R@10 entity-distractor | R@10 no-entity |
| --- | ---: | ---: | ---: | ---: |
| `vector` | 1.000 | 0.760 | 1.000 | 1.000 |
| `graph` | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid` | 1.000 | 0.760 | 1.000 | 1.000 |
| `graph@hop1` | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid@hop1` | 1.000 | 0.760 | 1.000 | 1.000 |
| `graph@hop3` | 0.000 | 0.000 | 0.000 | 0.000 |
| `hybrid@hop3` | 1.000 | 0.760 | 1.000 | 1.000 |
| `graph·oracle@hop1` | 0.600 | 0.120 | 0.600 | 0.220 |
| `hybrid·oracle@hop1` | 1.000 | 0.180 | 1.000 | 1.000 |
| `graph·oracle` | 0.600 | 0.120 | 0.600 | 0.220 |
| `hybrid·oracle` | 1.000 | 0.180 | 1.000 | 1.000 |
| `graph·oracle@hop3` | 0.600 | 0.120 | 0.600 | 0.220 |
| `hybrid·oracle@hop3` | 1.000 | 0.180 | 1.000 | 1.000 |
| `graph·oracle·per-fact@hop1` | 0.940 | 0.100 | 0.840 | 0.240 |
| `hybrid·oracle·per-fact@hop1` | 1.000 | 0.180 | 1.000 | 1.000 |
| `graph·oracle·per-fact` | 0.940 | 0.100 | 0.840 | 0.240 |
| `hybrid·oracle·per-fact` | 1.000 | 0.180 | 1.000 | 1.000 |
| `graph·oracle·per-fact@hop3` | 0.940 | 0.100 | 0.840 | 0.240 |
| `hybrid·oracle·per-fact@hop3` | 1.000 | 0.180 | 1.000 | 1.000 |

## Where relevant facts were found

Each relevant (query, fact) pair, by which of the two lists the facade fuses held it — pgvector at 2 × topK and the graph reader's full list. `Graph only` is what the graph found that the vector path did not. `Union recall` is the ceiling fusion could reach.

| Fused lists of | Stratum | Vector only | Graph only | Both | Neither | Union recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `hybrid` | all | 198 | 0 | 0 | 3 | 0.985 |
| `hybrid` | paraphrase | 50 | 0 | 0 | 0 | 1.000 |
| `hybrid` | relational | 47 | 0 | 0 | 3 | 0.940 |
| `hybrid` | entity-distractor | 50 | 0 | 0 | 0 | 1.000 |
| `hybrid` | no-entity | 51 | 0 | 0 | 0 | 1.000 |
| `hybrid@hop1` | all | 198 | 0 | 0 | 3 | 0.985 |
| `hybrid@hop1` | paraphrase | 50 | 0 | 0 | 0 | 1.000 |
| `hybrid@hop1` | relational | 47 | 0 | 0 | 3 | 0.940 |
| `hybrid@hop1` | entity-distractor | 50 | 0 | 0 | 0 | 1.000 |
| `hybrid@hop1` | no-entity | 51 | 0 | 0 | 0 | 1.000 |
| `hybrid@hop3` | all | 198 | 0 | 0 | 3 | 0.985 |
| `hybrid@hop3` | paraphrase | 50 | 0 | 0 | 0 | 1.000 |
| `hybrid@hop3` | relational | 47 | 0 | 0 | 3 | 0.940 |
| `hybrid@hop3` | entity-distractor | 50 | 0 | 0 | 0 | 1.000 |
| `hybrid@hop3` | no-entity | 51 | 0 | 0 | 0 | 1.000 |
| `hybrid·oracle@hop1` | all | 58 | 0 | 140 | 3 | 0.985 |
| `hybrid·oracle@hop1` | paraphrase | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle@hop1` | relational | 19 | 0 | 28 | 3 | 0.940 |
| `hybrid·oracle@hop1` | entity-distractor | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle@hop1` | no-entity | 39 | 0 | 12 | 0 | 1.000 |
| `hybrid·oracle` | all | 58 | 0 | 140 | 3 | 0.985 |
| `hybrid·oracle` | paraphrase | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle` | relational | 19 | 0 | 28 | 3 | 0.940 |
| `hybrid·oracle` | entity-distractor | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle` | no-entity | 39 | 0 | 12 | 0 | 1.000 |
| `hybrid·oracle@hop3` | all | 58 | 0 | 140 | 3 | 0.985 |
| `hybrid·oracle@hop3` | paraphrase | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle@hop3` | relational | 19 | 0 | 28 | 3 | 0.940 |
| `hybrid·oracle@hop3` | entity-distractor | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle@hop3` | no-entity | 39 | 0 | 12 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop1` | all | 42 | 3 | 156 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop1` | paraphrase | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop1` | relational | 3 | 3 | 44 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop1` | entity-distractor | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop1` | no-entity | 39 | 0 | 12 | 0 | 1.000 |
| `hybrid·oracle·per-fact` | all | 42 | 3 | 156 | 0 | 1.000 |
| `hybrid·oracle·per-fact` | paraphrase | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle·per-fact` | relational | 3 | 3 | 44 | 0 | 1.000 |
| `hybrid·oracle·per-fact` | entity-distractor | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle·per-fact` | no-entity | 39 | 0 | 12 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop3` | all | 42 | 3 | 156 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop3` | paraphrase | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop3` | relational | 3 | 3 | 44 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop3` | entity-distractor | 0 | 0 | 50 | 0 | 1.000 |
| `hybrid·oracle·per-fact@hop3` | no-entity | 39 | 0 | 12 | 0 | 1.000 |

## Operational

| Condition | Empty | Context chars @10 | Latency p50 ms | Latency p95 ms |
| --- | ---: | ---: | ---: | ---: |
| `vector` | 0.0% | 803 | 2.2 | 3.3 |
| `graph` | 100.0% | 0 | 3.2 | 4.4 |
| `hybrid` | 0.0% | 803 | 5.3 | 7.8 |
| `graph@hop1` | 100.0% | 0 | 3.0 | 4.3 |
| `hybrid@hop1` | 0.0% | 803 | 4.6 | 7.4 |
| `graph@hop3` | 100.0% | 0 | 2.7 | 3.6 |
| `hybrid@hop3` | 0.0% | 803 | 4.2 | 6.3 |
| `graph·oracle@hop1` | 19.0% | 644 | 3.0 | 6.5 |
| `hybrid·oracle@hop1` | 0.0% | 811 | 4.5 | 8.2 |
| `graph·oracle` | 19.0% | 648 | 1.5 | 2.7 |
| `hybrid·oracle` | 0.0% | 811 | 2.0 | 3.4 |
| `graph·oracle@hop3` | 19.0% | 648 | 1.6 | 2.8 |
| `hybrid·oracle@hop3` | 0.0% | 811 | 1.9 | 3.2 |
| `graph·oracle·per-fact@hop1` | 19.0% | 653 | 0.8 | 1.6 |
| `hybrid·oracle·per-fact@hop1` | 0.0% | 808 | 1.7 | 2.9 |
| `graph·oracle·per-fact` | 19.0% | 663 | 1.1 | 1.9 |
| `hybrid·oracle·per-fact` | 0.0% | 808 | 1.8 | 3.3 |
| `graph·oracle·per-fact@hop3` | 19.0% | 663 | 1.1 | 1.9 |
| `hybrid·oracle·per-fact@hop3` | 0.0% | 808 | 1.7 | 3.0 |

## Tie sensitivity

The graph orders facts at one hop distance by content hash. Each graph list's ties were re-sorted under 20 fixed salts and re-fused with `rrfMerge`; the value is at the production tie-break, the range is min–max over the salts.

| Condition | R@1 | R@10 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: |
| `graph` | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] |
| `hybrid` | 0.757 [0.757–0.757] | 0.940 [0.940–0.940] | 0.845 [0.845–0.845] | 0.815 [0.815–0.815] |
| `graph@hop1` | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] |
| `hybrid@hop1` | 0.757 [0.757–0.757] | 0.940 [0.940–0.940] | 0.845 [0.845–0.845] | 0.815 [0.815–0.815] |
| `graph@hop3` | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] | 0.000 [0.000–0.000] |
| `hybrid@hop3` | 0.757 [0.757–0.757] | 0.940 [0.940–0.940] | 0.845 [0.845–0.845] | 0.815 [0.815–0.815] |
| `graph·oracle@hop1` | 0.040 [0.020–0.080] | 0.385 [0.350–0.440] | 0.180 [0.159–0.210] | 0.119 [0.099–0.145] |
| `hybrid·oracle@hop1` | 0.388 [0.343–0.443] | 0.795 [0.780–0.815] | 0.577 [0.564–0.615] | 0.508 [0.493–0.553] |
| `graph·oracle` | 0.040 [0.020–0.080] | 0.385 [0.350–0.440] | 0.180 [0.159–0.210] | 0.119 [0.099–0.145] |
| `hybrid·oracle` | 0.388 [0.343–0.443] | 0.795 [0.780–0.815] | 0.577 [0.564–0.615] | 0.508 [0.493–0.553] |
| `graph·oracle@hop3` | 0.040 [0.020–0.080] | 0.385 [0.350–0.440] | 0.180 [0.159–0.210] | 0.119 [0.099–0.145] |
| `hybrid·oracle@hop3` | 0.388 [0.343–0.443] | 0.795 [0.780–0.815] | 0.577 [0.564–0.615] | 0.508 [0.493–0.553] |
| `graph·oracle·per-fact@hop1` | 0.090 [0.045–0.125] | 0.530 [0.485–0.540] | 0.274 [0.253–0.304] | 0.197 [0.173–0.233] |
| `hybrid·oracle·per-fact@hop1` | 0.477 [0.453–0.517] | 0.795 [0.790–0.835] | 0.638 [0.631–0.659] | 0.588 [0.569–0.610] |
| `graph·oracle·per-fact` | 0.090 [0.045–0.125] | 0.530 [0.485–0.540] | 0.274 [0.253–0.304] | 0.197 [0.173–0.233] |
| `hybrid·oracle·per-fact` | 0.477 [0.453–0.517] | 0.795 [0.790–0.835] | 0.638 [0.631–0.659] | 0.588 [0.569–0.610] |
| `graph·oracle·per-fact@hop3` | 0.090 [0.045–0.125] | 0.530 [0.485–0.540] | 0.274 [0.253–0.304] | 0.197 [0.173–0.233] |
| `hybrid·oracle·per-fact@hop3` | 0.477 [0.453–0.517] | 0.795 [0.790–0.835] | 0.638 [0.631–0.659] | 0.588 [0.569–0.610] |

Re-fusion reproduces the facade's output: `hybrid` yes, `hybrid@hop1` yes, `hybrid@hop3` yes, `hybrid·oracle@hop1` yes, `hybrid·oracle` yes, `hybrid·oracle@hop3` yes, `hybrid·oracle·per-fact@hop1` yes, `hybrid·oracle·per-fact` yes, `hybrid·oracle·per-fact@hop3` yes.

What the graph reader's `LIMIT 50` cut, computed from the corpus:

| Condition | Queries at limit | Facts cut | Tied at the cut | Store agrees with corpus |
| --- | ---: | ---: | ---: | ---: |
| `graph` | 0 | 0 | 0 | 200 / 200 |
| `graph@hop1` | 0 | 0 | 0 | 200 / 200 |
| `graph@hop3` | 0 | 0 | 0 | 200 / 200 |
| `graph·oracle@hop1` | 131 | 5045 | 4885 | 200 / 200 |
| `graph·oracle` | 152 | 15112 | 5645 | 200 / 200 |
| `graph·oracle@hop3` | 162 | 30387 | 6167 | 200 / 200 |
| `graph·oracle·per-fact@hop1` | 76 | 681 | 681 | 200 / 200 |
| `graph·oracle·per-fact` | 138 | 9029 | 3714 | 200 / 200 |
| `graph·oracle·per-fact@hop3` | 158 | 20714 | 4305 | 200 / 200 |

## Query–label overlap

Mean Jaccard over lowercased word sets, query against each relevant fact:

| Stratum | Overlap |
| --- | ---: |
| paraphrase | 0.214 |
| relational | 0.144 |
| entity-distractor | 0.344 |
| no-entity | 0.300 |

## Vector query plan

```
Limit
  ->  Sort
        Sort Key: ((embedding <=> '[768 values]'::vector)), content_hash
        ->  Seq Scan on semantic_facts
              Filter: (session_id = '3c9e7a14-2b58-4f06-8d1e-6a4b2c0f9e71'::uuid)
```
