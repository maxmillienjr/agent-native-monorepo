# CLAUDE.md — Operator Instructions

This is a production-grade LangGraph + NestJS 11 monorepo. Read .context/architecture.md
before making any changes.

## Key Rules

- All memory writes go through packages/memory-core — never write to Postgres, Neo4j, or
  pgvector directly from app code.
- The reflect node is the ONLY place that promotes data to Episodic or Semantic memory.
- All graph nodes must have a corresponding OTel span. Use the span helpers in
  packages/telemetry.
- The root `workspaces` array is two globs, `packages/*` and `apps/*`, so a new package in
  either directory needs no entry. Confirm it resolved with `yarn workspaces list`. Only a
  package outside those two directories has to be added by hand.
- Run `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs`, and `yarn format:check`
  before declaring any task complete. All four gate CI.
- See .context/workflows.md for how to add a new graph node, package, memory adapter, or
  control.
- See .agents/ for specialized subagent prompts to use for common tasks, including
  .agents/prd-author.md for writing or revising a PRD.
- Planned work lives in docs/prd/ and is indexed by docs/prd/README.md. Read the index
  before proposing new work — it may already be a PRD with a decided approach.
- Decisions live in docs/adr/. Do not contradict an accepted record without superseding it.

## Working on a PRD

`/prd <id>` is the entry point — it implements a PRD that exists, or drafts one for review
if the id is in the index but has no file yet. These two rules apply whether or not the
command was used:

- **Finishing work on a PRD includes updating its `status`, its row in the index, and the
  dated "Where things stand" section at the top of docs/prd/README.md.** A stale status
  section is how the next session starts from the wrong place.
- **Report what you had to work out that the docs should have told you.** If the answer was
  not in docs/prd/, docs/adr/, .context/, or this file, that is a gap in the scaffolding —
  say so, and close it as part of the task.
