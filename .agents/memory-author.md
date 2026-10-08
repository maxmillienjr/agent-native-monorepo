# Memory Author Subagent

You are a specialized agent for adding or modifying memory adapters in `packages/memory-core`.

## Before Writing Code

1. Read `packages/memory-core/src/index.ts` to see the existing facade exports.
2. Read the interface you are implementing (in the relevant tier directory).
3. Read `.context/architecture.md` for the Three-Brain memory model.

## Idempotent Write Semantics

This is the most critical constraint. All writes must be replay-safe:

### Neo4j

- **Always use `MERGE`, never `CREATE`.** A re-run of the `reflect` node on the same
  `runId` must produce identical graph state.
- Include provenance metadata: `episodeId`, `confidence`, `createdAt`.
- Example:
  ```cypher
  MERGE (c:Concept {id: $id})
  ON CREATE SET c.label = $label, c.description = $description
  ON MATCH SET c.label = $label, c.description = $description
  ```

### pgvector

- **Always upsert on `content_hash`, never bare `INSERT`.** Duplicate fact text must not
  create duplicate rows.
- Use `ON CONFLICT (content_hash) DO UPDATE` pattern.
- Example:
  ```sql
  INSERT INTO semantic_facts (content_hash, text, embedding, episode_id, session_id)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (content_hash) DO UPDATE SET text = EXCLUDED.text
  ```

### Episodic

- The natural key is `(session_id, turn_index)`, and the write is
  `ON CONFLICT (session_id, turn_index) DO NOTHING`. Do not add a read-before-write: the
  constraint is the check, and a `SELECT` first is a race, not a guard.
- `run_id` is a column, not part of the key. `reflect` writes the whole client-supplied
  history on every run, so keying on `run_id` returns each turn once per run — which is not
  the full turn history the tier is specified to hold.
- First write wins. The log records what was first seen; it is not a mirror of the client's
  current history. P3-B kept that and answered the audit question elsewhere: an edited,
  re-sent turn is in the run record of the run that sent it (ADR 0007), so an audit never
  reads `episodes`.
- The run record (`src/audit/`) is the one write in this package that is not idempotent
  memory: `run_decisions` is a bare `INSERT`, because a taken ordinal means two writers own
  one run. Its migrations are additive-only (`.context/conventions.md`, Migrations).

## Testing Requirements

- **Integration tests only** — no mocking Neo4j or Postgres.
- Real databases, not containers you start yourself: `docker-compose.yml` provides them
  locally and `e2e.yml` provides them as service containers. The suites read `DATABASE_URL`
  and `NEO4J_URI` and skip when those are unset. This repo has never used `testcontainers`.
- Verify round-trip: write → read → assert expected data.
- Verify idempotency: write twice with same data → assert no duplicates.
- Place tests in `packages/memory-core/test/`.

## After Writing

1. Export from `packages/memory-core/src/index.ts`.
2. Wrap all I/O in OTel spans using `@repo/telemetry`.
3. Run `yarn turbo typecheck && yarn turbo test:integration`.
