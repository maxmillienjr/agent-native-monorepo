# Architecture Decision Records

One file per decision, numbered sequentially, in the format popularized by Michael Nygard:
context, decision, consequences. A record is never edited after it reaches `accepted` —
if the decision changes, write a new record and mark the old one `superseded by NNNN`.

The bar for writing one: a reviewer would reasonably ask "why did you do it that way,"
and the answer is not obvious from the code.

| ID                                                                  | Title                                                                | Status             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------ |
| [0001](0001-langgraph-over-a-durable-execution-engine.md)           | LangGraph over a durable execution engine                            | accepted           |
| [0002](0002-neo4j-and-pgvector-rather-than-one-store.md)            | Neo4j and pgvector rather than one store                             | superseded by 0009 |
| [0003](0003-payer-domain-with-licensing-and-phi-as-the-boundary.md) | Payer domain in scope, with licensed content and PHI as the boundary | accepted           |
| [0004](0004-one-candidate-universe-for-fusion.md)                   | One candidate universe for rank fusion                               | accepted           |
| [0005](0005-decision-seam-rather-than-transport-for-replay.md)      | Record at the decision seam rather than at the transport             | accepted           |
| [0006](0006-deterministic-retrieval-order-over-the-vector-index.md) | A deterministic retrieval order over the vector index                | accepted           |
| [0008](0008-code-systems-the-repository-may-contain.md)             | The code systems this repository may contain                         | accepted           |
| [0009](0009-the-second-store-after-the-retrieval-ablation.md)       | The second store, after the retrieval ablation                       | accepted           |
| [0012](0012-the-graphs-explanation-role-stage-one.md)               | The graph's explanation role, after stage 1                          | proposed           |
