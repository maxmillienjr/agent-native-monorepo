# agent-native-monorepo

![ci](https://img.shields.io/github/actions/workflow/status/maxmillienjr/agent-native-monorepo/ci.yml?branch=main)

> A production-grade chassis for stateful LangGraph agents, purpose-built for multi-agent development workflows.

A Yarn 4 monorepo containing a NestJS 11 microservice that runs a LangGraph state machine designed around a **Three-Brain memory architecture**: per-run Working Memory, session-scoped Episodic Memory (Postgres + Drizzle ORM), and long-term Semantic Memory retrieved from pgvector dense embeddings, with a Neo4j 5 knowledge graph written beside it. This project demonstrates the intersection of senior monorepo engineering and production agentic systems: it is an extraction of production patterns from a proprietary platform, sanitized for public consumption.

> **What is wired, and what is not.** All three memory tiers are live: `MemoryModule`
> constructs the adapters and `RunsService` injects them, so a run reads from Postgres and
> pgvector, and writes to all three stores, when `DATABASE_URL` and `NEO4J_URI` are set.
> Retrieval is vector-only by decision, after a measurement found the graph did not help
> ([ADR 0009](docs/adr/0009-the-second-store-after-the-retrieval-ablation.md)).
> `packages/eval-harness` measures the agent, and `agent-eval.yml` runs it on every pull
> request on replayed model decisions and compares every grader result with a committed
> baseline, so any change in behaviour turns `eval-replay` red (P1-D). What this repository
> cannot claim yet is that red stops a merge: the ruleset that makes `eval-replay` a
> required check is `.github/rulesets/main.json`, and applying it is the owner's.
> [`docs/STATUS.md`](docs/STATUS.md) is the per-capability matrix, and it is the file to
> trust when this README and the code disagree.

---

## Architecture

### System Overview

```mermaid
graph TD
    Console["console<br/>(React + Vite)"]
    Gateway["gateway<br/>(Express)"]
    Agent["agent-service<br/>(NestJS 11 + LangGraph)"]
    Memory["memory-core<br/>(unified facade)"]
    PG["Postgres 16<br/>+ pgvector"]
    Neo["Neo4j 5<br/>Community"]

    Console -->|HTTP| Gateway
    Gateway -->|proxy| Agent
    Agent --> Memory
    Memory --> PG
    Memory --> Neo
```

### LangGraph Node Graph

```mermaid
graph LR
    S((START)) --> ingress
    ingress --> retrieve
    retrieve --> plan
    plan --> act
    act -->|"stepCount < maxSteps<br/>& shouldContinue"| act
    act -->|"loop done"| distill
    distill --> reflect
    reflect --> egress
    egress --> E((END))
```

### Three-Brain Memory Model

```mermaid
graph TD
    WM["Working Memory<br/>(LangGraph AgentState)"]
    EM["Episodic Memory<br/>(Postgres + Drizzle)"]
    Neo4j["Neo4j Knowledge Graph<br/>(entities + relationships)"]
    PGV["pgvector Collection<br/>(dense embeddings)"]

    WM -->|"reflect node"| EM
    EM -->|"reflect node"| Neo4j
    EM -->|"reflect node"| PGV
    PGV -->|"cosine search (retrieve node)"| WM
```

---

## Why This Exists

This repository is an extraction of production patterns from a proprietary agentic platform, sanitized for public consumption. It is **not** a tutorial, starter kit, or SaaS template.

It exists to demonstrate architectural thinking in two domains that rarely overlap:

1. **Senior monorepo engineering** — Yarn 4 workspaces, Turborepo build orchestration, shared TypeScript configs, and Zod schemas as the single source of truth for every type that crosses a package boundary.
2. **Production agentic systems** — LangGraph state machines, a three-tier memory whose retrieval design was measured against pre-registered labels and changed when the measurement came back negative, OpenTelemetry instrumentation at the graph-node level.

Both lists are wired into the request path. `MemoryModule` constructs the adapters and
`RunsService` injects them, so a run reads from Postgres and pgvector and writes to all
three stores when `DATABASE_URL` and `NEO4J_URI` are set, and runs against a stub dependency set when
they are not. The agent is measured, too — `yarn eval` runs trials and reports `pass@k` and
`pass^k`, on every pull request against recorded model decisions and nightly against the
live model once a key secret exists. A regression gate reads those numbers: on the replay
axis any difference from the committed baseline is red, and on the live axis a pooled
comparison says `regressed`, `held` or — until enough nights exist — `insufficient-evidence`.
Red blocks a merge once the owner applies `.github/rulesets/main.json`. See
[`docs/STATUS.md`](docs/STATUS.md) before quoting this section back at the code.

The agent's domain logic is intentionally trivial (a single system prompt: _"You are a helpful research assistant."_). The value is in the chassis — how the pieces connect, how memory is structured, how observability is wired, and how the monorepo scales.

---

## Quickstart

```bash
git clone https://github.com/<owner>/agent-native-monorepo
cd agent-native-monorepo
yarn install
docker compose up -d    # Postgres + pgvector, Neo4j
yarn dev                # Starts all services in dev mode

# Request/response mode
curl -X POST http://localhost:3001/runs \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "550e8400-e29b-41d4-a716-446655440000", "messages": [{"role": "user", "content": "What is LangGraph?"}]}'

# Streaming mode (SSE)
curl -N -X POST http://localhost:3001/runs/stream \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "550e8400-e29b-41d4-a716-446655440000", "messages": [{"role": "user", "content": "What is LangGraph?"}]}'
```

### Prerequisites

- Node.js 24.x (not required for [Full-Stack Docker](#full-stack-docker))
- Docker and Docker Compose

Both quickstart curls above work against a fresh clone with no `.env` at all: with no
`GOOGLE_API_KEY` set, the service runs the graph against a deterministic stub dependency
set, which is also what CI exercises.

Memory is a second, independent axis. Set `DATABASE_URL` and `NEO4J_URI` — as
`docker compose --profile full` does — and the service constructs the real adapters, runs
its migrations, installs the Neo4j constraints and checkpoints every run. Set neither and
it runs against deterministic stubs. Set one without the other and it refuses to start,
because falling back to no-op writers when a configured database is missing is how a
system quietly stops persisting anything.

Copy `.env.example` to `.env` if you want to point the service at your own infrastructure:

```bash
cp .env.example .env
```

The service reads that file at boot. A variable already set in the environment still wins —
which is what a container, a CI runner and a secrets manager all assume — so a long-lived
`export GOOGLE_API_KEY=...` in a shell rc file will quietly outrank the file you just
edited. Boot names any variable in that state: look for `env.file.shadowed` in the log,
which lists the variable names whose `.env` values are not in use.

### Full-Stack Docker

To run the entire stack (infra + all apps) in Docker without Node.js installed:

```bash
docker compose --profile full up --build
```

| Service       | URL                   |
| ------------- | --------------------- |
| Console       | http://localhost:8080 |
| Gateway       | http://localhost:3001 |
| Agent Service | http://localhost:3000 |
| Neo4j Browser | http://localhost:7474 |

`docker compose up` (without `--profile`) still starts only the infrastructure services for local `yarn dev` development.

---

## Three-Brain Memory

The memory system is three tiers with distinct scopes, persistence strategies, and access patterns, and all three are live. Working Memory is in-process. The other two are implemented in `packages/memory-core`, covered by integration tests against real Postgres and Neo4j, and constructed by `apps/agent-service`: `MemoryModule` builds the pool, the driver, the four adapters and the retrieval facade, and `RunsService` injects them by token. A run reads from Postgres and pgvector, and writes to Postgres, Neo4j and pgvector, when `DATABASE_URL` and `NEO4J_URI` are set, and runs against a deterministic stub dependency set when they are not — memory and model are independent axes, and neither falls back. Per-capability detail is in [`docs/STATUS.md`](docs/STATUS.md).

### Working Memory

Per-run, in-process state held in the LangGraph `AgentState` object. Accumulates intermediate reasoning, tool outputs, and retrieved context. Destroyed at run completion — no external I/O.

### Episodic Memory

Session-scoped turn history persisted in Postgres via Drizzle ORM. Records the full conversation per `session_id` — both sides of it: `plan` appends the assistant's turn to `state.messages` before `reflect` persists them. Serves as raw material for Semantic tier promotion.

Retention is unbounded: there is no expiry column and no cleanup job. Writes upsert on the `(session_id, turn_index)` natural key, so a replayed run — or a re-sent history under a fresh `run_id` — lands on the same rows. First write wins, which makes the log a record of what was first seen rather than a mirror of the client's current history.

### Semantic Memory

> **Retrieval is vector-only, by decision, after a negative measurement.** The two-index design was meant to be the architectural differentiator. It was measured, the graph added nothing to retrieval on the deployed path and lowered recall with a perfect linker, and [ADR 0009](docs/adr/0009-the-second-store-after-the-retrieval-ablation.md) took it out of the read path. The `reflect` node still writes both indices. The graph is kept for an explanation role that has not been measured, so [`docs/STATUS.md`](docs/STATUS.md) row 15 marks it `stubbed`, and P2-D either measures that role or removes the graph.

The `reflect` node writes Postgres, then Neo4j, then pgvector, in three sequential loops. Each write is replay-safe — the episodic natural key, Cypher `MERGE`, and pgvector upsert on a content hash — and `reflect` reads its extraction from state rather than deriving it, so a retried attempt writes exactly what the first attempt wrote. The three are still not atomic together: a crash between them leaves the indices disagreeing until the retry, not permanently. That guarantee is convergence under replay, not exactly-once; [ADR 0001](docs/adr/0001-langgraph-over-a-durable-execution-engine.md) explains why the stronger one was not bought, and an outbox would be a new PRD.

| Index            | Technology | What It Stores                                   | Read on a run?                                         |
| ---------------- | ---------- | ------------------------------------------------ | ------------------------------------------------------ |
| Dense Embeddings | pgvector   | Distilled fact embeddings (768-dim)              | Yes: exact cosine similarity via `<=>`, session-scoped |
| Knowledge Graph  | Neo4j 5    | Entities (`:Concept`, `:Fact`) and relationships | No, since ADR 0009: written, not read                  |

**Why there were two, and what the measurement found.** [ADR 0002](docs/adr/0002-neo4j-and-pgvector-rather-than-one-store.md) ran both on the theory that dense search and graph traversal fail on different questions, so their union recalls more than either. P2-B measured that on 200 labelled queries with `yarn eval:retrieval`, under a decision rule fixed before the run. It did not hold. On the deployed path `hybrid` and `vector` score the same Recall@10, 0.940, because the seed linker produced no id the graph holds on any of the 200 queries. With the linker replaced by perfect seeds, `hybrid` scores 0.145 _below_ `vector`. The graph ranks only by hop distance, and RRF gives its hash-ordered list the same weight as the vector list. That held in the relational queries built to favour the graph: 0.180 against 0.760. The rule selected "neither does", under both the pre-registered and the blind-adjudicated labels. The report is committed under `packages/eval-harness/datasets/retrieval-ablation/reports/`, and `yarn eval:retrieval` still reproduces it: it measures the fused design ADR 0009 retired, which survives only inside the ablation.

Until ADR 0009 the two lists were merged with **Reciprocal Rank Fusion (RRF)**, keyed on the fact's content hash. That only became fusion once the graph stored facts too — `(:Fact)-[:MENTIONS]->(:Concept)`, keyed on the same hash — so that both readers returned the same kind of object ([ADR 0004](docs/adr/0004-one-candidate-universe-for-fusion.md)). `reflect` still writes the `:Fact` copy. No request fuses anything now.

Retrieval is scoped to the requesting session by default, with an explicit `crossSession` opt-out. The graph has no session scope, which [P4-B](docs/prd/P4-B-memory-poisoning-red-team.md) found let it return another session's facts. Taking the graph out of the read path closed that, and the graph filter now belongs to P2-D, before anything reads the graph again.

---

## LangGraph Node Reference

`distill` and `reflect` are separate nodes so that `reflect` can carry a retry policy. A
node is only safe to retry when it is a function of its input state, and a `reflect` that
extracted its own entities was not: a second attempt could word a fact differently, change
its hash, and write an extra row rather than converging on the first attempt's.

| Node       | Purpose                         | Key Input Fields               | Key Output Fields                        | Side Effects                                  |
| ---------- | ------------------------------- | ------------------------------ | ---------------------------------------- | --------------------------------------------- |
| `ingress`  | Validate request, seed state    | Raw HTTP body                  | Full `AgentState`                        | None                                          |
| `retrieve` | Semantic recall, vector-only    | `messages`, `topK`             | `retrievedContext`                       | pgvector search                               |
| `plan`     | LLM planning step               | `messages`, `retrievedContext` | `currentPlan`, `messages`, `tokenCounts` | LLM API call                                  |
| `act`      | Tool execution loop             | `currentPlan`                  | `toolOutputs`, `stepCount`               | Tool invocations                              |
| `distill`  | Extract entities and facts      | `messages`                     | `extraction`                             | LLM API call                                  |
| `reflect`  | Memory consolidation            | `messages`, `extraction`       | _(none — side-effect node)_              | Episodic insert, Neo4j MERGE, pgvector upsert |
| `egress`   | Validate output, build response | Full state                     | `outcome`                                | None                                          |

---

## Contributing

1. Fork the repository and create a feature branch.
2. Read `.context/conventions.md` for code style and naming rules, and `docs/STATUS.md`
   before adding a sentence that describes what the system does.
3. For non-trivial work, start with a PRD — see `docs/prd/README.md` for the backlog and
   `.context/workflows.md` for the flow. Decisions are recorded in `docs/adr/`.
4. Follow the step-by-step guides in `.context/workflows.md` for:
   - Adding a new graph node
   - Adding a new package
   - Adding a new memory adapter
   - Adding or changing a control in `governance/controls.yaml`
5. Use the specialized subagent prompts in `.agents/` if working with AI coding tools.
6. See `AGENTS.md` for cross-tool compatibility notes (Cursor, Kilo Code, Continue, Aider).
7. Run `yarn turbo typecheck && yarn turbo lint` before submitting a PR.
8. Use Conventional Commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `ci:`.
